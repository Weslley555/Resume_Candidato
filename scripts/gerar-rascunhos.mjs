/**
 * gerar-rascunhos.mjs — CLI offline para geração antecipada de rascunhos de resumo.
 *
 * USO:
 *   node scripts/gerar-rascunhos.mjs [opções]
 *
 * OPÇÕES:
 *   --dry-run                  Planeja sem chamar o Gemini nem gravar arquivos.
 *                              Exibe: candidaturas elegíveis, blocos, chamadas estimadas.
 *   --candidaturas=C1,C2,...   Processa apenas as chaves canônicas listadas.
 *   --documentos=H1,H2         Seleção de PDFs; exige exatamente uma candidatura.
 *   --max-chamadas=N           Orçamento máximo desta execução (padrão: 20).
 *   --modelo=NOME              Modelo Gemini a usar (padrão: gemini-3.5-flash).
 *   --dir=CAMINHO              Diretório de checkpoints (padrão: ./checkpoints/rascunhos).
 *   --pausa=MS                 Pausa entre chamadas em ms (padrão: 4000).
 *
 * COMPORTAMENTO:
 *   - Nunca executa automaticamente; exige invocação explícita do mantenedor.
 *   - Nunca roda durante `npm run build`.
 *   - Salva checkpoints atômicos por bloco. Retoma a partir do último bloco completo.
 *   - Invalida checkpoints se mudar candidatura/seleção, extração, prompt, modelo ou divisão.
 *   - Exclusão mútua por lockfile: dois processos simultâneos do mesmo job são impedidos.
 *   - Respeita Retry-After curto, pausa em quota diária e aplica orçamento total de chamadas.
 *   - Rascunho final é artefato offline pronto para `node scripts/revisar-resumo.mjs`.
 *   - Não publica; não altera manifesto; não consome quota do endpoint público.
 *
 * FLUXO COMPLETO:
 *   1. node scripts/gerar-rascunhos.mjs --dry-run
 *   2. node scripts/gerar-rascunhos.mjs --candidaturas=2026_1_MG_123
 *   3. node scripts/revisar-resumo.mjs checkpoints/rascunhos/<job>/rascunho.json publicado.json "Revisora" \
 *        --aprovar --conferi-neutralidade --conferi-referencias --conferi-cobertura
 *   4. Incluir publicado.json em data/resumos_publicados/<hash>.json no deploy.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    carregarFonte, resolverChave, prepararContexto, criarBlocos, validarSaida,
    criarRegistro, validarRegistro, MODELOS, VERSAO_PROMPT, SYSTEM_PROMPT, PROMPT_HASH, sha256, serializar, falha,
} from '../lib/resumos.js';
import {
    chaveJob, adquirirLock, liberarLock, lerParametrosJob, salvarParametrosJob,
    lerCheckpoint, salvarCheckpoint, lerRascunho, salvarRascunho, invalidarJob,
    blocosConcluidos,
} from '../lib/checkpoints.js';

// ─── Gerador Gemini injetável ─────────────────────────────────────────────────

async function gerarBlocoGemini({ modelo, paginas, systemInstruction }) {
    const { GoogleGenAI } = await import('@google/genai');
    const chave = process.env.GEMINI_API_KEY;
    if (!chave?.trim()) throw falha('GEMINI_API_KEY não configurada.', 503);
    const ai = new GoogleGenAI({ apiKey: chave });
    const resposta = await ai.models.generateContent({
        model: modelo,
        contents: JSON.stringify({ paginas }),
        config: {
            systemInstruction,
            responseMimeType: 'application/json',
            temperature: 0.2,
            abortSignal: AbortSignal.timeout(60000),
            maxOutputTokens: 8192,
            httpOptions: { timeout: 60000, retryOptions: { attempts: 1 } },
        },
    });
    if (resposta.promptFeedback?.blockReason || resposta.candidates?.[0]?.finishReason !== 'STOP'
        || typeof resposta.text !== 'string') throw falha('Resposta bloqueada ou incompleta.', 502);
    return resposta.text;
}

// ─── Núcleo de processamento ──────────────────────────────────────────────────

/**
 * Processa um único job (candidatura + seleção + modelo).
 * Retoma blocos pendentes; invalida checkpoints se parâmetros mudaram.
 * Retorna o registro do rascunho ou lança erro.
 */
export function parametrosJob(ctx, modelo, blocos, limiteBlocoBytes = 24000) {
    return {
        schemaVersion: 2, chave: ctx.chave, exportacao: ctx.fonte.exportacao,
        snapshotHash: ctx.fonte.snapshotHash, fonteHash: ctx.fonte.fonteHash,
        documentosSelecionados: ctx.base.documentosSelecionados,
        extracoesHash: ctx.docs.map(doc => ({ sha256: doc.sha256, hash: sha256(serializar(doc)) })),
        versaoPrompt: VERSAO_PROMPT, promptHash: PROMPT_HASH, modelo,
        limiteBlocoBytes, totalBlocos: blocos.length,
        blocosHash: blocos.map(bloco => sha256(serializar(bloco))),
    };
}

function checkpointValido(checkpoint, index, bloco, blocoHash) {
    try {
        return checkpoint?.schemaVersion === 1 && checkpoint.blocoIndex === index
            && checkpoint.blocoHash === blocoHash
            && validarSaida({ afirmacoes: checkpoint.afirmacoes, cobertura: checkpoint.cobertura }, bloco);
    } catch { return false; }
}

export async function processarJob(ctx, { modelo, dirBase, pausaMs = 4000, limiteBlocoBytes = 24000,
    maxChamadas = 20, maxTentativas = 2, consumirChamada, gerarBloco = gerarBlocoGemini, log = console.log }) {
    const blocos = criarBlocos(ctx.paginas, limiteBlocoBytes);
    const totalBlocos = blocos.length;
    const params = parametrosJob(ctx, modelo, blocos, limiteBlocoBytes);
    const jobKey = chaveJob(params);
    const jobDir = path.join(dirBase, jobKey);

    // Verifica se já tem rascunho final completo
    const rascunhoExistente = lerRascunho(jobDir);
    if (rascunhoExistente) {
        try {
            const valido = validarRegistro(rascunhoExistente, ctx, modelo);
            log(`[${ctx.chave}] Rascunho já completo: ${jobDir}/rascunho.json`);
            return valido;
        } catch { invalidarJob(jobDir); }
    }

    // Tenta adquirir lock
    const lockFd = adquirirLock(jobDir);
    if (lockFd === null) {
        throw new Error(`[${ctx.chave}] Job em andamento em outro processo. Aguarde ou remova o lock em ${jobDir}/lock`);
    }

    try {
        // Verifica compatibilidade dos checkpoints existentes
        const paramsExistentes = lerParametrosJob(jobDir);
        if (paramsExistentes && serializar(paramsExistentes) !== serializar(params)) {
            log(`[${ctx.chave}] Parâmetros mudaram. Invalidando checkpoints anteriores.`);
            liberarLock(lockFd, jobDir);
            invalidarJob(jobDir);
            const novoFd = adquirirLock(jobDir);
            if (novoFd === null) throw new Error(`[${ctx.chave}] Falha ao readquirir lock após invalidação.`);
            // Continua com o novo lock implicitamente (novoFd não é o original)
            // Relança para o chamador reiniciar
            liberarLock(novoFd, jobDir);
            return processarJob(ctx, { modelo, dirBase, pausaMs, limiteBlocoBytes, maxChamadas,
                maxTentativas, consumirChamada, gerarBloco, log });
        }

        salvarParametrosJob(jobDir, params);

        const saida = { afirmacoes: [], cobertura: [] };
        let chamadasLocais = 0;

        for (let i = 0; i < totalBlocos; i++) {
            // Tenta ler checkpoint existente
            const checkpoint = lerCheckpoint(jobDir, i);
            if (checkpointValido(checkpoint, i, blocos[i], params.blocosHash[i])) {
                log(`[${ctx.chave}] Bloco ${i + 1}/${totalBlocos}: retomando do checkpoint.`);
                saida.afirmacoes.push(...checkpoint.afirmacoes);
                saida.cobertura.push(...checkpoint.cobertura);
                continue;
            }

            log(`[${ctx.chave}] Bloco ${i + 1}/${totalBlocos}: gerando (${blocos[i].length} página(s))…`);

            let resultado;
            let tentativas = 0;
            while (true) {
                tentativas++;
                if (consumirChamada) consumirChamada();
                else if (++chamadasLocais > maxChamadas) throw falha(`Orçamento offline de ${maxChamadas} chamada(s) esgotado. Retome depois com um orçamento explícito.`, 429);
                try {
                    resultado = await gerarBloco({ modelo, paginas: blocos[i], systemInstruction: SYSTEM_PROMPT });
                    break;
                } catch (erro) {
                    if (erro?.status === 429) {
                        const retryAfter = Number(erro?.retryAfter);
                        if (!Number.isFinite(retryAfter) || retryAfter >= 3600 || tentativas >= maxTentativas) {
                            const quota = falha('Quota esgotada; processamento pausado com checkpoints preservados.', 429);
                            quota.retryAfter = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.ceil(retryAfter) : null;
                            throw quota;
                        }
                        const espera = Math.max(0, retryAfter) * 1000;
                        log(`[${ctx.chave}] Quota temporária. Respeitando Retry-After de ${Math.round(espera / 1000)}s…`);
                        await sleep(espera);
                        continue;
                    }
                    throw erro; // propaga sem descartar blocos anteriores
                }
            }

            const parsed = typeof resultado === 'string' ? JSON.parse(resultado) : resultado;
            const validado = validarSaida(parsed, blocos[i]);

            // Checkpoint atômico antes de avançar
            salvarCheckpoint(jobDir, i, { schemaVersion: 1, blocoIndex: i, blocoHash: params.blocosHash[i],
                concluidoEm: new Date().toISOString(), afirmacoes: validado.afirmacoes, cobertura: validado.cobertura });
            saida.afirmacoes.push(...validado.afirmacoes);
            saida.cobertura.push(...validado.cobertura);
            log(`[${ctx.chave}] Bloco ${i + 1}/${totalBlocos}: OK (${validado.afirmacoes.length} proposta(s)).`);

            // Pausa entre blocos para respeitar quota
            if (i < totalBlocos - 1) await sleep(pausaMs);
        }

        const registro = criarRegistro(ctx, modelo, saida);
        salvarRascunho(jobDir, registro);
        log(`[${ctx.chave}] Rascunho salvo: ${jobDir}/rascunho.json`);
        return registro;
    } finally {
        liberarLock(lockFd, jobDir);
    }
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── Modo dry-run ─────────────────────────────────────────────────────────────

export function planejar(fonte, { candidaturas, selecoes = {}, modelo, dirBase, limiteBlocoBytes = 24000, log = console.log }) {
    const chaves = candidaturas?.length
        ? candidaturas.map(id => {
            const c = resolverChave(id, fonte);
            if (!c) throw new Error(`Candidatura não encontrada: ${id}`);
            return c;
        })
        : Object.keys(fonte.textos);

    let totalBlocos = 0, totalChamadas = 0;
    const relatorio = [];

    for (const chave of chaves) {
        if (!Object.hasOwn(fonte.candidatos, chave)) continue;
        const ctx = prepararContexto(fonte, chave, selecoes[chave]);
        if (ctx.resposta) {
            relatorio.push({ chave, elegivel: false, motivo: ctx.resposta.estado });
            continue;
        }

        let blocos;
        try {
            blocos = criarBlocos(ctx.paginas, limiteBlocoBytes);
        } catch (err) {
            relatorio.push({ chave, elegivel: false, motivo: err.message });
            continue;
        }

        const params = parametrosJob(ctx, modelo, blocos, limiteBlocoBytes);
        const jobKey = chaveJob(params);
        const jobDir = path.join(dirBase, jobKey);
        const concluidos = blocosConcluidos(jobDir, blocos,
            (checkpoint, index, bloco) => checkpointValido(checkpoint, index, bloco, params.blocosHash[index]));
        const pendentes = blocos.length - concluidos.length;
        let rascunhoOk = false;
        try { rascunhoOk = validarRegistro(lerRascunho(jobDir), ctx, modelo).estado === 'rascunho_gerado'; } catch { /* ausente ou incompatível */ }

        totalBlocos += blocos.length;
        totalChamadas += pendentes;

        relatorio.push({
            chave, elegivel: true, totalBlocos: blocos.length, concluidos: concluidos.length,
            pendentes, rascunhoCompleto: rascunhoOk,
            paginasTotais: ctx.paginas.length,
            avisoOCR: ctx.avisoRevisaoOCR,
        });
    }

    log('\n=== DRY-RUN: Plano de geração de rascunhos ===\n');
    log(`Modelo: ${modelo}`);
    log(`Diretório de checkpoints: ${dirBase}\n`);
    for (const item of relatorio) {
        if (!item.elegivel) {
            log(`  ✗ ${item.chave} — inelegível (${item.motivo})`);
        } else if (item.rascunhoCompleto) {
            log(`  ✓ ${item.chave} — rascunho já completo (${item.totalBlocos} bloco(s))`);
        } else {
            const ocr = item.avisoOCR ? ' [alerta OCR]' : '';
            log(`  ○ ${item.chave} — ${item.paginasTotais} pág → ${item.totalBlocos} bloco(s), ${item.concluidos} concluído(s), ${item.pendentes} pendente(s)${ocr}`);
        }
    }
    log(`\nTotal de blocos: ${totalBlocos} | Chamadas Gemini estimadas: ${totalChamadas}`);
    log('\nNenhuma ação executada em modo dry-run.\n');
    return relatorio;
}

// ─── Ponto de entrada CLI ─────────────────────────────────────────────────────

export async function main(args, deps = {}) {
    const dryRun = args.includes('--dry-run');
    const modeloArg = args.find(a => a.startsWith('--modelo='))?.split('=')[1] ?? MODELOS[0];
    const dirArg = args.find(a => a.startsWith('--dir='))?.split('=')[1] ?? './checkpoints/rascunhos';
    const pausaArg = parseInt(args.find(a => a.startsWith('--pausa='))?.split('=')[1] ?? '4000', 10);
    const candidaturasArg = args.find(a => a.startsWith('--candidaturas='))?.split('=')[1]?.split(',').filter(Boolean);
    const documentosArg = args.find(a => a.startsWith('--documentos='))?.split('=')[1]?.split(',').filter(Boolean);
    const maxChamadasArg = parseInt(args.find(a => a.startsWith('--max-chamadas='))?.split('=')[1] ?? '20', 10);

    if (!MODELOS.includes(modeloArg)) throw new Error(`Modelo inválido: ${modeloArg}. Aceitos: ${MODELOS.join(', ')}`);
    if (Number.isNaN(pausaArg) || pausaArg < 0) throw new Error('--pausa deve ser número inteiro ≥ 0 (em ms).');
    if (!Number.isSafeInteger(maxChamadasArg) || maxChamadasArg < 1) throw new Error('--max-chamadas deve ser inteiro ≥ 1.');
    if (documentosArg && candidaturasArg?.length !== 1) throw new Error('--documentos exige exatamente uma candidatura em --candidaturas.');

    const carregar = deps.carregarFonte ?? carregarFonte;
    const log = deps.log ?? console.log;
    const gerarBloco = deps.gerarBloco;

    const fonte = carregar();
    const dirBase = path.resolve(dirArg);
    const chaveSelecao = candidaturasArg?.length === 1 ? resolverChave(candidaturasArg[0], fonte) : null;
    const selecoes = documentosArg ? { [chaveSelecao]: documentosArg } : {};

    if (dryRun) {
        return planejar(fonte, { candidaturas: candidaturasArg, selecoes, modelo: modeloArg, dirBase, log });
    }

    // Modo de execução real
    const chaves = candidaturasArg?.length
        ? candidaturasArg.map(id => {
            const c = resolverChave(id, fonte);
            if (!c) throw new Error(`Candidatura não encontrada: ${id}`);
            return c;
        })
        : Object.keys(fonte.textos);

    const resultados = [];
    let chamadasConsumidas = 0;
    const consumirChamada = () => {
        if (chamadasConsumidas >= maxChamadasArg) throw falha(`Orçamento offline de ${maxChamadasArg} chamada(s) esgotado. Checkpoints foram preservados.`, 429);
        chamadasConsumidas++;
    };
    for (const chave of chaves) {
        if (!Object.hasOwn(fonte.candidatos, chave)) {
            log(`[${chave}] Candidatura não encontrada no snapshot, pulando.`);
            continue;
        }
        const ctx = prepararContexto(fonte, chave, selecoes[chave]);
        if (ctx.resposta) {
            log(`[${chave}] Inelegível (${ctx.resposta.estado}): ${ctx.resposta.motivo ?? ''}`);
            resultados.push({ chave, ok: false, motivo: ctx.resposta.estado });
            continue;
        }

        try {
            const registro = await processarJob(ctx, { modelo: modeloArg, dirBase, pausaMs: pausaArg,
                maxChamadas: maxChamadasArg, consumirChamada, gerarBloco, log });
            resultados.push({ chave, ok: true, cacheKey: registro.cacheKey });
        } catch (erro) {
            log(`[${chave}] Erro: ${erro.message}`);
            resultados.push({ chave, ok: false, motivo: erro.message });
        }
    }

    return resultados;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main(process.argv.slice(2)).then(resultados => {
        if (resultados && !process.argv.includes('--dry-run')) {
            const ok = resultados.filter(r => r.ok).length;
            const falhou = resultados.filter(r => !r.ok).length;
            console.log(`\nConcluído: ${ok} rascunho(s) gerado(s)${falhou ? `, ${falhou} falha(s)` : ''}.`);
            console.log('Use node scripts/revisar-resumo.mjs para revisar e publicar.');
        }
    }).catch(err => {
        console.error(`Erro: ${err.message}`);
        process.exitCode = 1;
    });
}
