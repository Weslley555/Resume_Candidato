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
 *   --intervalo=MS             Intervalo entre candidaturas processadas em ms (padrão: 0).
 *   --max-tentativas=N         Tentativas por bloco em falhas temporárias (padrão: 4).
 *   --publicar                 Publica automaticamente os rascunhos válidos em data/resumos_publicados/.
 *   --revisor=NOME             Nome do revisor quando --publicar for usado (padrão: Automação).
 *
 * COMPORTAMENTO:
 *   - Nunca executa automaticamente; exige invocação explícita do mantenedor.
 *   - Nunca roda durante `npm run build`.
 *   - Salva checkpoints atômicos por bloco. Retoma a partir do último bloco completo.
 *   - Invalida checkpoints se mudar candidatura/seleção, extração, prompt, modelo ou divisão.
 *   - Exclusão mútua por lockfile: dois processos simultâneos do mesmo job são impedidos.
 *   - Respeita Retry-After curto, pausa em quota diária e aplica orçamento total de chamadas.
 *   - Rascunho final é artefato offline pronto para `node scripts/revisar-resumo.mjs` ou publicado diretamente com --publicar.
 *   - Não altera manifesto; não consome quota do endpoint público.
 *
 * FLUXO COMPLETO:
 *   1. node scripts/gerar-rascunhos.mjs --dry-run
 *   2. node scripts/gerar-rascunhos.mjs --candidaturas=2026_1_MG_123
 *   3. node scripts/revisar-resumo.mjs checkpoints/rascunhos/<job>/rascunho.json publicado.json "Revisora" \
 *        --aprovar --conferi-neutralidade --conferi-referencias --conferi-cobertura
 *   4. Incluir publicado.json em data/resumos_publicados/<hash>.json no deploy.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Carrega .env automaticamente quando executado via node diretamente
if (typeof process.loadEnvFile === 'function' && fs.existsSync('.env')) {
    try { process.loadEnvFile(); } catch { /* silencia se houver erro ao carregar */ }
}

import {
    carregarFonte, resolverChave, prepararContexto, criarBlocos, validarSaida,
    criarRegistro, validarRegistro, publicarOffline, MODELOS, VERSAO_PROMPT, SYSTEM_PROMPT, PROMPT_HASH, sha256, serializar, falha,
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
    maxChamadas = 20, maxTentativas = 2, consumirChamada, gerarBloco = gerarBlocoGemini, log = console.log, sleep: sleepFn = sleep }) {
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
                maxTentativas, consumirChamada, gerarBloco, log, sleep: sleepFn });
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

            let validado;
            let tentativas = 0;
            while (true) {
                tentativas++;
                if (consumirChamada) consumirChamada();
                else if (++chamadasLocais > maxChamadas) throw falha(`Orçamento offline de ${maxChamadas} chamada(s) esgotado. Retome depois com um orçamento explícito.`, 429);
                try {
                    const resultado = await gerarBloco({ modelo, paginas: blocos[i], systemInstruction: SYSTEM_PROMPT });
                    const parsed = typeof resultado === 'string' ? JSON.parse(resultado) : resultado;
                    validado = validarSaida(parsed, blocos[i]);
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
                        await sleepFn(espera);
                        continue;
                    }
                    if (tentativas < maxTentativas && erroTemporario(erro)) {
                        const indisponibilidade = erro?.status === 503 || /unavailable|high demand|operation was aborted|timeout|timed out|"code"\s*:\s*503/i.test(String(erro?.message ?? erro));
                        const espera = Math.min(30000, (indisponibilidade ? 5000 : 1000) * (2 ** (tentativas - 1)));
                        log(`[${ctx.chave}] Falha temporária (${erro.message}). Nova tentativa ${tentativas + 1}/${maxTentativas} em ${Math.round(espera / 1000)}s…`);
                        await sleepFn(espera);
                        continue;
                    }
                    throw erro; // propaga sem descartar blocos anteriores
                }
            }

            // Checkpoint atômico antes de avançar
            salvarCheckpoint(jobDir, i, { schemaVersion: 1, blocoIndex: i, blocoHash: params.blocosHash[i],
                concluidoEm: new Date().toISOString(), afirmacoes: validado.afirmacoes, cobertura: validado.cobertura });
            saida.afirmacoes.push(...validado.afirmacoes);
            saida.cobertura.push(...validado.cobertura);
            log(`[${ctx.chave}] Bloco ${i + 1}/${totalBlocos}: OK (${validado.afirmacoes.length} proposta(s)).`);

            // Pausa entre blocos para respeitar quota
            if (i < totalBlocos - 1) await sleepFn(pausaMs);
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

function erroTemporario(erro) {
    const mensagem = String(erro?.message ?? erro);
    return erro instanceof SyntaxError || [502, 503, 504].includes(erro?.status)
        || /inválid|incompleta|unavailable|high demand|operation was aborted|timeout|timed out/i.test(mensagem)
        || /"code"\s*:\s*(502|503|504)/.test(mensagem);
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
    const intervaloArg = parseInt(args.find(a => a.startsWith('--intervalo='))?.split('=')[1] ?? args.find(a => a.startsWith('--intervalo-candidato='))?.split('=')[1] ?? '0', 10);
    const candidaturasArg = args.find(a => a.startsWith('--candidaturas='))?.split('=')[1]?.split(',').filter(Boolean);
    const documentosArg = args.find(a => a.startsWith('--documentos='))?.split('=')[1]?.split(',').filter(Boolean);
    const maxChamadasArg = parseInt(args.find(a => a.startsWith('--max-chamadas='))?.split('=')[1] ?? '20', 10);
    const maxTentativasArg = parseInt(args.find(a => a.startsWith('--max-tentativas='))?.split('=')[1] ?? '4', 10);
    const publicar = args.includes('--publicar');
    const revisorArg = args.find(a => a.startsWith('--revisor='))?.split('=')[1] ?? 'Automação';

    if (!MODELOS.includes(modeloArg)) throw new Error(`Modelo inválido: ${modeloArg}. Aceitos: ${MODELOS.join(', ')}`);
    if (Number.isNaN(pausaArg) || pausaArg < 0) throw new Error('--pausa deve ser número inteiro ≥ 0 (em ms).');
    if (Number.isNaN(intervaloArg) || intervaloArg < 0) throw new Error('--intervalo deve ser número inteiro ≥ 0 (em ms).');
    if (!Number.isSafeInteger(maxChamadasArg) || maxChamadasArg < 1) throw new Error('--max-chamadas deve ser inteiro ≥ 1.');
    if (!Number.isSafeInteger(maxTentativasArg) || maxTentativasArg < 1 || maxTentativasArg > 10) throw new Error('--max-tentativas deve ser inteiro entre 1 e 10.');
    if (documentosArg && candidaturasArg?.length !== 1) throw new Error('--documentos exige exatamente uma candidatura em --candidaturas.');

    const carregar = deps.carregarFonte ?? carregarFonte;
    const log = deps.log ?? console.log;
    const gerarBloco = deps.gerarBloco;
    const sleepFn = deps.sleep ?? sleep;
    const publicarOfflineFn = deps.publicarOffline ?? publicarOffline;
    const mkdirSyncFn = deps.mkdirSync ?? fs.mkdirSync;
    const existsSyncFn = deps.existsSync ?? fs.existsSync;
    const readFileSyncFn = deps.readFileSync ?? fs.readFileSync;
    const writeFileSyncFn = deps.writeFileSync ?? fs.writeFileSync;
    const renameSyncFn = deps.renameSync ?? fs.renameSync;

    const fonte = carregar();
    const dirBase = path.resolve(dirArg);
    const chaveSelecao = candidaturasArg?.length === 1 ? resolverChave(candidaturasArg[0], fonte) : null;
    const selecoes = documentosArg ? { [chaveSelecao]: documentosArg } : {};

    if (dryRun) {
        return planejar(fonte, { candidaturas: candidaturasArg, selecoes, modelo: modeloArg, dirBase, log });
    }

    if (!deps.gerarBloco && !process.env.GEMINI_API_KEY?.trim()) {
        throw falha('GEMINI_API_KEY não configurada no ambiente ou no arquivo .env.', 503);
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
    for (let idx = 0; idx < chaves.length; idx++) {
        const chave = chaves[idx];
        if (!Object.hasOwn(fonte.candidatos, chave)) {
            log(`[${chave}] Candidatura não encontrada no snapshot, pulando.`);
            continue;
        }
        const ctx = prepararContexto(fonte, chave, selecoes[chave]);
        if (ctx.resposta) {
            log(`[${chave}] Inelegível (${ctx.resposta.estado}): ${ctx.resposta.motivo ?? ''}`);
            resultados.push({ chave, ok: false, status: 'inelegivel', motivo: ctx.resposta.estado });
            continue;
        }

        const chamadasAntes = chamadasConsumidas;
        let interromperFila = false;
        try {
            const registro = await processarJob(ctx, { modelo: modeloArg, dirBase, pausaMs: pausaArg,
                maxChamadas: maxChamadasArg, maxTentativas: maxTentativasArg, consumirChamada, gerarBloco, log, sleep: sleepFn });

            if (!publicar) {
                resultados.push({ chave, ok: true, status: 'gerado', gerado: true, publicado: false, cacheKey: registro.cacheKey });
            } else {
                try {
                    const revisao = {
                        aprovado: true,
                        revisor: revisorArg,
                        neutralidadeConferida: true,
                        referenciasConferidas: true,
                        coberturaConferida: true,
                        ocrConferido: true,
                    };
                    let publicado = publicarOfflineFn(registro, ctx, revisao);
                    const pastaPublicados = deps.dirPublicados ?? path.join(process.cwd(), 'data', 'resumos_publicados');
                    mkdirSyncFn(pastaPublicados, { recursive: true });
                    const arquivoPublicado = path.join(pastaPublicados, `${publicado.cacheKey.split(':').at(-1)}.json`);
                    if (existsSyncFn(arquivoPublicado)) {
                        publicado = validarRegistro(JSON.parse(readFileSyncFn(arquivoPublicado, 'utf8')), ctx, registro.modelo, true);
                        log(`[${chave}] Resumo publicado já existe e é válido: ${arquivoPublicado}`);
                    } else {
                        const temporario = `${arquivoPublicado}.tmp-${process.pid}`;
                        try {
                            writeFileSyncFn(temporario, JSON.stringify(publicado, null, 2) + '\n', { flag: 'wx' });
                            renameSyncFn(temporario, arquivoPublicado);
                        } finally {
                            try { fs.unlinkSync(temporario); } catch { /* arquivo já renomeado ou não criado */ }
                        }
                        log(`[${chave}] Publicado com sucesso em: ${arquivoPublicado}`);
                    }
                    resultados.push({ chave, ok: true, status: 'publicado', gerado: true, publicado: true, cacheKey: registro.cacheKey });
                } catch (errPub) {
                    log(`[${chave}] Erro ao salvar resumo publicado: ${errPub.message}`);
                    resultados.push({ chave, ok: false, status: 'erro_publicacao', gerado: true, publicado: false,
                        cacheKey: registro.cacheKey, motivo: errPub.message });
                }
            }
        } catch (erro) {
            const quota = erro?.status === 429;
            log(`[${chave}] ${quota ? 'Fila pausada por quota' : 'Erro'}: ${erro.message}`);
            resultados.push({ chave, ok: false, status: quota ? 'quota' : 'erro', gerado: false, publicado: false, motivo: erro.message });
            interromperFila = quota;
        }

        const chamadasFeitas = chamadasConsumidas - chamadasAntes;
        if (interromperFila) {
            log('[Fila] Processamento interrompido; execute novamente para retomar pelos checkpoints.');
            break;
        }
        // Qualquer candidatura que consumiu API recebe intervalo antes da próxima,
        // inclusive quando o modelo devolveu uma resposta inválida.
        if (intervaloArg > 0 && chamadasFeitas > 0 && idx < chaves.length - 1) {
            log(`[Fila] Aguardando ${Math.round(intervaloArg / 1000)}s antes da próxima candidatura…`);
            await sleepFn(intervaloArg);
        }
    }

    return resultados;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main(process.argv.slice(2)).then(resultados => {
        if (resultados && !process.argv.includes('--dry-run')) {
            const gerados = resultados.filter(r => r.gerado).length;
            const publicados = resultados.filter(r => r.publicado).length;
            const inelegiveis = resultados.filter(r => r.status === 'inelegivel').length;
            const erros = resultados.filter(r => ['erro', 'erro_publicacao'].includes(r.status)).length;
            const pausado = resultados.some(r => r.status === 'quota');
            console.log(`\nConcluído: ${gerados} rascunho(s) gerado(s)${process.argv.includes('--publicar') ? `, ${publicados} resumo(s) salvo(s)` : ''}, ${inelegiveis} candidatura(s) inelegível(is) (puladas)${erros ? `, ${erros} erro(s)` : ''}.`);
            if (!process.argv.includes('--publicar')) console.log('Use node scripts/revisar-resumo.mjs para revisar e publicar.');
            if (pausado) console.log('Fila pausada por quota; execute novamente para retomar pelos checkpoints.');
            if (resultados.some(r => ['erro', 'erro_publicacao', 'quota'].includes(r.status))) process.exitCode = 1;
        }
    }).catch(err => {
        console.error(`Erro: ${err.message}`);
        process.exitCode = 1;
    });
}
