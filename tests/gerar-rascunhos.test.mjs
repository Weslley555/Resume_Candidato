/**
 * Testes offline para scripts/gerar-rascunhos.mjs e lib/checkpoints.js.
 * Todos os casos usam mocks; nenhuma chamada real ao Gemini é feita.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
    MODELOS, VERSAO_PROMPT, sha256, criarBlocos, criarRegistro, prepararContexto,
    validarSaida, TEMAS,
} from '../lib/resumos.js';
import {
    chaveJob, adquirirLock, liberarLock, lerParametrosJob, salvarParametrosJob,
    lerCheckpoint, salvarCheckpoint, lerRascunho, salvarRascunho, invalidarJob,
    blocosConcluidos,
} from '../lib/checkpoints.js';
import { processarJob, parametrosJob, planejar, main } from '../scripts/gerar-rascunhos.mjs';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const chave = '2026_6259_MG_123';
const h1 = 'a'.repeat(64), h2 = 'b'.repeat(64);

function documento(hash = h1, textos = ['Proposta da página 1', 'Proposta da página 2']) {
    return {
        sha256: hash, sha256Fonte: hash, nome: 'Plano.pdf',
        arquivo: `assets/proposta/${chave}/${hash}.pdf`,
        totalPaginas: textos.length, aptoParaRascunho: true, requerRevisaoOCR: false,
        statusExtracao: 'texto_extraido', paginasPendentes: [], paginasBrancas: [],
        paginasParaRevisao: [], paginasSemTexto: [], paginasOCR: [],
        paginas: textos.map((texto, i) => ({ pagina: i + 1, texto, status: 'extraido', revisar: false })),
    };
}

function fonte(docs = [documento()]) {
    return {
        textos: { [chave]: docs },
        documentos: { [chave]: { propostas: [] } },
        candidatos: { [chave]: {} },
        aliases: {},
        exportacao: 'run-1', fonteHash: h1, snapshotHash: h1,
        verificarPDF() {},
    };
}

function saidaValida(paginas) {
    return {
        afirmacoes: paginas.filter(p => p.texto.trim()).map(p => ({
            tipo: 'proposta', tema: 'Saúde', texto: 'Ampliar serviços de saúde.',
            referencias: [{ sha256: p.sha256, pagina: p.pagina }],
        })),
        cobertura: paginas.map(({ sha256, pagina }) => ({ sha256, pagina })),
    };
}

const gerador = async ({ paginas }) => saidaValida(paginas);

function tmpDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'rc-test-'));
}

// ─── Testes de checkpoints ────────────────────────────────────────────────────

test('chaveJob é determinística e muda com qualquer parâmetro', () => {
    const params = {
        chave, exportacao: 'run-1', fonteHash: h1,
        documentosSelecionados: [h1], versaoPrompt: VERSAO_PROMPT,
        modelo: MODELOS[0], totalBlocos: 2,
    };
    const key1 = chaveJob(params);
    assert.match(key1, /^[a-f0-9]{64}$/);
    for (const [campo, valor] of Object.entries({
        chave: '2026_1_MG_999', exportacao: 'run-2', fonteHash: h2,
        documentosSelecionados: [h2], versaoPrompt: VERSAO_PROMPT + '2',
        modelo: MODELOS[1], totalBlocos: 3,
    })) {
        assert.notEqual(chaveJob({ ...params, [campo]: valor }), key1, `mudança em ${campo}`);
    }
});

test('adquirirLock garante exclusão mútua; segundo tentante recebe null', () => {
    const dir = tmpDir();
    const jobDir = path.join(dir, 'job1');
    const fd1 = adquirirLock(jobDir);
    assert.ok(fd1 !== null, 'primeiro deve obter o lock');
    const fd2 = adquirirLock(jobDir);
    assert.equal(fd2, null, 'segundo deve ser bloqueado');
    liberarLock(fd1, jobDir);
    // Após liberar, terceiro pode adquirir
    const fd3 = adquirirLock(jobDir);
    assert.ok(fd3 !== null);
    liberarLock(fd3, jobDir);
    fs.rmSync(dir, { recursive: true });
});

test('checkpoint atômico: salvar/ler/invalida corretamente', () => {
    const dir = tmpDir();
    const jobDir = path.join(dir, 'job2');
    fs.mkdirSync(jobDir, { recursive: true });
    assert.equal(lerCheckpoint(jobDir, 0), null, 'sem checkpoint ainda');
    salvarCheckpoint(jobDir, 0, { afirmacoes: [{ texto: 'ok' }], cobertura: [] });
    const cp = lerCheckpoint(jobDir, 0);
    assert.deepEqual(cp.afirmacoes, [{ texto: 'ok' }]);
    // Arquivo .tmp não deve sobrar
    assert.equal(fs.existsSync(path.join(jobDir, 'bloco-00000.json.tmp')), false);
    // Rascunho final
    salvarRascunho(jobDir, { estado: 'rascunho_gerado' });
    assert.equal(lerRascunho(jobDir)?.estado, 'rascunho_gerado');
    // Invalidar remove tudo
    invalidarJob(jobDir);
    assert.equal(fs.existsSync(jobDir), false);
    fs.rmSync(dir, { recursive: true });
});

test('blocosConcluidos lista corretamente blocos presentes', () => {
    const dir = tmpDir();
    const jobDir = path.join(dir, 'job3');
    fs.mkdirSync(jobDir);
    salvarCheckpoint(jobDir, 0, { afirmacoes: [], cobertura: [] });
    salvarCheckpoint(jobDir, 2, { afirmacoes: [], cobertura: [] });
    assert.deepEqual(blocosConcluidos(jobDir, 3), [0, 2]);
    fs.rmSync(dir, { recursive: true });
});

// ─── Testes de processarJob ───────────────────────────────────────────────────

test('documento curto: processa em um bloco, salva rascunho', async () => {
    const dir = tmpDir();
    const f = fonte();
    const ctx = prepararContexto(f, chave);
    const registro = await processarJob(ctx, { modelo: MODELOS[0], dirBase: dir, pausaMs: 0, gerarBloco: gerador });
    assert.equal(registro.estado, 'rascunho_gerado');
    assert.equal(registro.chave, chave);
    assert.ok(registro.afirmacoes.length > 0);
    // Arquivo salvo no disco
    const blocos = criarBlocos(ctx.paginas);
    const jobDir = path.join(dir, chaveJob(parametrosJob(ctx, MODELOS[0], blocos)));
    assert.ok(lerRascunho(jobDir) !== null);
    fs.rmSync(dir, { recursive: true });
});

test('documento extenso: múltiplos blocos são processados e consolidados', async () => {
    const dir = tmpDir();
    // 4 páginas de 8000 chars; com limite de 10000 bytes por bloco caberão 1 por bloco
    const textos = Array.from({ length: 4 }, (_, i) => 'x'.repeat(8000) + ` pagina${i}`);
    const f = fonte([documento(h1, textos)]);
    const ctx = prepararContexto(f, chave);
    const limite = 9000; // força 1 página por bloco
    const blocos = criarBlocos(ctx.paginas, limite);
    assert.ok(blocos.length > 1, 'deve ter múltiplos blocos');
    let chamadas = 0;
    const gerarBlocoContar = async ({ paginas }) => { chamadas++; return saidaValida(paginas); };
    const registro = await processarJob(ctx, { modelo: MODELOS[0], dirBase: dir, pausaMs: 0,
        limiteBlocoBytes: limite, gerarBloco: gerarBlocoContar });
    assert.equal(chamadas, blocos.length);
    assert.equal(registro.estado, 'rascunho_gerado');
    assert.equal(registro.cobertura.length, ctx.paginas.length);
    fs.rmSync(dir, { recursive: true });
});

test('interrupção e retomada: bloco concluído não é reprocessado', async () => {
    const dir = tmpDir();
    // 4 páginas de 8000 chars; com limite de 9000 bytes por bloco caberá 1 por bloco
    const textos = Array.from({ length: 4 }, (_, i) => 'x'.repeat(8000) + ` pagina${i}`);
    const f = fonte([documento(h1, textos)]);
    const ctx = prepararContexto(f, chave);
    const limite = 9000;
    const blocos = criarBlocos(ctx.paginas, limite);
    assert.ok(blocos.length >= 2);
    const params = parametrosJob(ctx, MODELOS[0], blocos, limite);
    const jobDir = path.join(dir, chaveJob(params));
    // Pré-salva checkpoint do bloco 0 (simulando processo anterior que gerou o bloco 0)
    const saida0 = saidaValida(blocos[0]);
    salvarCheckpoint(jobDir, 0, { schemaVersion: 1, blocoIndex: 0, blocoHash: params.blocosHash[0], ...saida0 });
    salvarParametrosJob(jobDir, params);
    const chamadas = [];
    const gerarBlocoRastrear = async ({ paginas }) => {
        chamadas.push(paginas[0].pagina);
        return saidaValida(paginas);
    };
    const registro = await processarJob(ctx, { modelo: MODELOS[0], dirBase: dir, pausaMs: 0,
        limiteBlocoBytes: limite, gerarBloco: gerarBlocoRastrear });
    // Somente os blocos 1+ foram chamados (bloco 0 estava no checkpoint)
    assert.ok(!chamadas.includes(blocos[0][0].pagina), 'bloco 0 não deve ser reprocessado');
    assert.equal(registro.estado, 'rascunho_gerado');
    fs.rmSync(dir, { recursive: true });
});

test('invalidação de checkpoints quando parâmetros mudam', async () => {
    const dir = tmpDir();
    const f = fonte();
    const ctx = prepararContexto(f, chave);
    const blocos = criarBlocos(ctx.paginas);
    const params = parametrosJob(ctx, MODELOS[0], blocos);
    const jobDir = path.join(dir, chaveJob(params));
    // Salva parâmetros diferentes (simulando mudança de modelo)
    salvarParametrosJob(jobDir, { ...params, modelo: MODELOS[1] });
    salvarCheckpoint(jobDir, 0, { blocoIndex: 0, afirmacoes: [{ texto: 'ANTIGO' }], cobertura: [] });
    let chamadas = 0;
    const gerarBlocoContar = async ({ paginas }) => { chamadas++; return saidaValida(paginas); };
    const registro = await processarJob(ctx, { modelo: MODELOS[0], dirBase: dir, pausaMs: 0, gerarBloco: gerarBlocoContar });
    // Checkpoints antigos foram descartados; todos os blocos foram reprocessados
    assert.equal(chamadas, blocos.length);
    assert.equal(registro.estado, 'rascunho_gerado');
    assert.ok(registro.afirmacoes.every(a => a.texto !== 'ANTIGO'));
    fs.rmSync(dir, { recursive: true });
});

test('concorrência: segundo processo simultâneo do mesmo job é rejeitado', async () => {
    const dir = tmpDir();
    const f = fonte();
    const ctx = prepararContexto(f, chave);
    const blocos = criarBlocos(ctx.paginas);
    const params = parametrosJob(ctx, MODELOS[0], blocos);
    const jobDir = path.join(dir, chaveJob(params));
    // Adquire o lock manualmente para simular processo em andamento
    const fd = adquirirLock(jobDir);
    assert.ok(fd !== null);
    salvarParametrosJob(jobDir, params);
    try {
        await assert.rejects(
            processarJob(ctx, { modelo: MODELOS[0], dirBase: dir, pausaMs: 0, gerarBloco: gerador }),
            /andamento|lock/i,
        );
    } finally {
        liberarLock(fd, jobDir);
        fs.rmSync(dir, { recursive: true });
    }
});

test('quota 429: pausa e tenta novamente uma vez; segunda falha propaga sem descartar blocos anteriores', async () => {
    const dir = tmpDir();
    // 4 páginas de 8000 chars; com limite de 9000 bytes por bloco caberá 1 por bloco (4 blocos)
    const textos = Array.from({ length: 4 }, (_, i) => 'x'.repeat(8000) + ` pagina${i}`);
    const f = fonte([documento(h1, textos)]);
    const ctx = prepararContexto(f, chave);
    const limite = 9000;
    const blocos = criarBlocos(ctx.paginas, limite);
    assert.ok(blocos.length >= 2);
    const params = parametrosJob(ctx, MODELOS[0], blocos, limite);
    const jobDir = path.join(dir, chaveJob(params));
    let tentativasBloco1 = 0;
    const chamadas = [];
    const gerarBlocoQuota = async ({ paginas }) => {
        const primeiraP = paginas[0].pagina;
        chamadas.push(primeiraP);
        // Bloco 1 (segundo bloco, index 1): primeiro retorna 429, segundo tem sucesso
        if (primeiraP === blocos[1][0].pagina) {
            tentativasBloco1++;
            if (tentativasBloco1 < 2) {
                const err = new Error('Quota atingida');
                err.status = 429;
                err.retryAfter = 0; // pausa zero para o teste ser rápido
                throw err;
            }
        }
        return saidaValida(paginas);
    };
    const registro = await processarJob(ctx, { modelo: MODELOS[0], dirBase: dir, pausaMs: 0,
        limiteBlocoBytes: limite, gerarBloco: gerarBlocoQuota });
    assert.equal(tentativasBloco1, 2);
    assert.equal(registro.estado, 'rascunho_gerado');
    // Bloco 0 foi processado antes e está no checkpoint
    const cp0 = lerCheckpoint(jobDir, 0);
    assert.ok(cp0 !== null, 'bloco 0 deve ter checkpoint');
    fs.rmSync(dir, { recursive: true });
});

test('falha sem quota não tenta novamente; blocos anteriores permanecem no checkpoint', async () => {
    const dir = tmpDir();
    // 4 páginas; com limite de 9000 bytes por bloco caberá 1 por bloco (4 blocos)
    const textos = Array.from({ length: 4 }, (_, i) => 'x'.repeat(8000) + ` pagina${i}`);
    const f = fonte([documento(h1, textos)]);
    const ctx = prepararContexto(f, chave);
    const limite = 9000;
    const blocos = criarBlocos(ctx.paginas, limite);
    assert.ok(blocos.length >= 2);
    const params = parametrosJob(ctx, MODELOS[0], blocos, limite);
    const jobDir = path.join(dir, chaveJob(params));
    let chamadas = 0;
    const gerarBlocoFalha = async ({ paginas }) => {
        chamadas++;
        // Falha no segundo bloco (index 1)
        if (paginas[0].pagina === blocos[1][0].pagina) throw new Error('Falha de rede sem quota');
        return saidaValida(paginas);
    };
    await assert.rejects(
        processarJob(ctx, { modelo: MODELOS[0], dirBase: dir, pausaMs: 0,
            limiteBlocoBytes: limite, gerarBloco: gerarBlocoFalha }),
        /Falha de rede/,
    );
    // Bloco 0 ainda tem checkpoint (não foi descartado)
    assert.ok(lerCheckpoint(jobDir, 0) !== null, 'bloco 0 deve persistir após falha no bloco 1');
    // Rascunho final NÃO foi salvo
    assert.equal(lerRascunho(jobDir), null, 'não deve publicar parcialmente');
    fs.rmSync(dir, { recursive: true });
});

test('saída inválida do Gemini (referências fictícias) é rejeitada antes do checkpoint', async () => {
    const dir = tmpDir();
    const f = fonte();
    const ctx = prepararContexto(f, chave);
    const gerarBlocoInvalido = async ({ paginas }) => ({
        afirmacoes: [{ tipo: 'proposta', tema: 'Saúde', texto: 'Proposta',
            referencias: [{ sha256: h2, pagina: 99 }] }], // referência fictícia
        cobertura: paginas.map(({ sha256, pagina }) => ({ sha256, pagina })),
    });
    await assert.rejects(
        processarJob(ctx, { modelo: MODELOS[0], dirBase: dir, pausaMs: 0, gerarBloco: gerarBlocoInvalido }),
        /referência|inválid/i,
    );
    // Nenhum checkpoint salvo para o bloco com saída inválida
    const blocos = criarBlocos(ctx.paginas);
    const jobDir = path.join(dir, chaveJob(parametrosJob(ctx, MODELOS[0], blocos)));
    assert.equal(lerCheckpoint(jobDir, 0), null);
    assert.equal(lerRascunho(jobDir), null);
    fs.rmSync(dir, { recursive: true });
});

test('checkpoint parseável com hash ou referências incompatíveis é reprocessado', async () => {
    const dir = tmpDir();
    const f = fonte();
    const ctx = prepararContexto(f, chave);
    const blocos = criarBlocos(ctx.paginas);
    const params = parametrosJob(ctx, MODELOS[0], blocos);
    const jobDir = path.join(dir, chaveJob(params));
    salvarParametrosJob(jobDir, params);
    salvarCheckpoint(jobDir, 0, { schemaVersion: 1, blocoIndex: 0, blocoHash: h2,
        ...saidaValida(blocos[0]) });
    let chamadas = 0;
    await processarJob(ctx, { modelo: MODELOS[0], dirBase: dir, pausaMs: 0,
        gerarBloco: async ({ paginas }) => { chamadas++; return saidaValida(paginas); } });
    assert.equal(chamadas, blocos.length);
    assert.equal(lerCheckpoint(jobDir, 0).blocoHash, params.blocosHash[0]);
    fs.rmSync(dir, { recursive: true });
});

test('orçamento offline pausa antes de exceder chamadas e preserva checkpoints', async () => {
    const dir = tmpDir();
    const textos = Array.from({ length: 3 }, (_, i) => 'x'.repeat(8000) + i);
    const f = fonte([documento(h1, textos)]);
    const ctx = prepararContexto(f, chave);
    const limite = 9000;
    const blocos = criarBlocos(ctx.paginas, limite);
    await assert.rejects(processarJob(ctx, { modelo: MODELOS[0], dirBase: dir,
        limiteBlocoBytes: limite, pausaMs: 0, maxChamadas: 1, gerarBloco: gerador }), /Orçamento offline/);
    const jobDir = path.join(dir, chaveJob(parametrosJob(ctx, MODELOS[0], blocos, limite)));
    assert.ok(lerCheckpoint(jobDir, 0));
    assert.equal(lerCheckpoint(jobDir, 1), null);
    assert.equal(lerRascunho(jobDir), null);
    fs.rmSync(dir, { recursive: true });
});

test('cobertura incompleta (página faltando) é rejeitada', async () => {
    const dir = tmpDir();
    const f = fonte();
    const ctx = prepararContexto(f, chave);
    const gerarBlocoCoberturaParcial = async ({ paginas }) => ({
        afirmacoes: [],
        cobertura: [paginas[0]].map(({ sha256, pagina }) => ({ sha256, pagina })), // falta pagina 2
    });
    await assert.rejects(
        processarJob(ctx, { modelo: MODELOS[0], dirBase: dir, pausaMs: 0, gerarBloco: gerarBlocoCoberturaParcial }),
        /cobertura/i,
    );
    fs.rmSync(dir, { recursive: true });
});

test('OCR apto com alerta: rascunho gerado mas marcado para revisão OCR', async () => {
    const dir = tmpDir();
    const doc = documento();
    doc.requerRevisaoOCR = true;
    doc.paginas[0].status = 'ocr_revisar';
    doc.paginas[0].revisar = true;
    const f = fonte([doc]);
    const ctx = prepararContexto(f, chave);
    // Com OCR apto, o contexto deve ter avisoRevisaoOCR
    assert.equal(ctx.avisoRevisaoOCR, true);
    // O processamento ainda funciona (avisoOCR não bloqueia geração offline)
    const registro = await processarJob(ctx, { modelo: MODELOS[0], dirBase: dir, pausaMs: 0, gerarBloco: gerador });
    assert.equal(registro.estado, 'rascunho_gerado');
    fs.rmSync(dir, { recursive: true });
});

test('extração pendente impede processarJob (prepararContexto bloqueia)', async () => {
    const dir = tmpDir();
    const doc = documento();
    doc.aptoParaRascunho = false;
    doc.paginasPendentes = [1];
    const f = fonte([doc]);
    // prepararContexto retorna resposta.estado = extracao_pendente
    const ctx = prepararContexto(f, chave);
    assert.equal(ctx.resposta?.estado, 'extracao_pendente');
    // main() pula candidaturas inelegíveis sem chamar o gerador
    const logs = [];
    const resultados = await main(['--candidaturas=' + chave], {
        carregarFonte: () => f,
        gerarBloco: async () => assert.fail('não deve gerar'),
        log: m => logs.push(m),
    });
    assert.equal(resultados.find(r => r.chave === chave)?.ok, false);
    fs.rmSync(dir, { recursive: true, force: true });
});

// ─── Testes de dry-run ────────────────────────────────────────────────────────

test('dry-run exibe plano sem chamar Gemini nem gravar arquivos', async () => {
    const dir = tmpDir();
    const f = fonte([documento(h1, ['Texto curto'])]);
    const logs = [];
    const relatorio = planejar(f, {
        candidaturas: [chave],
        modelo: MODELOS[0],
        dirBase: dir,
        log: m => logs.push(m),
    });
    assert.ok(logs.some(l => l.includes('DRY-RUN')));
    assert.ok(relatorio.some(r => r.chave === chave));
    // Nenhum arquivo gravado
    assert.equal(fs.readdirSync(dir).length, 0, 'dry-run não deve gravar arquivos');
    fs.rmSync(dir, { recursive: true });
});

test('CLI aceita seleção explícita de documento em candidatura com múltiplos PDFs', async () => {
    const dir = tmpDir();
    const f = fonte([documento(h1), documento(h2)]);
    let chamadas = 0;
    const resultados = await main([`--candidaturas=${chave}`, `--documentos=${h2}`, `--dir=${dir}`, '--pausa=0'], {
        carregarFonte: () => f,
        gerarBloco: async ({ paginas }) => { chamadas++; assert.ok(paginas.every(p => p.sha256 === h2)); return saidaValida(paginas); },
        log: () => {},
    });
    assert.equal(resultados[0].ok, true);
    assert.equal(chamadas, 1);
    fs.rmSync(dir, { recursive: true });
});

test('dry-run lista inelegíveis e pendentes separadamente', () => {
    const dir = tmpDir();
    const docPendente = documento(h2, ['texto']);
    docPendente.aptoParaRascunho = false;
    docPendente.paginasPendentes = [1];
    const chave2 = '2026_6259_MG_456';
    const f = {
        textos: { [chave]: [documento()], [chave2]: [docPendente] },
        documentos: { [chave]: { propostas: [] }, [chave2]: { propostas: [] } },
        candidatos: { [chave]: {}, [chave2]: {} },
        aliases: {}, exportacao: 'run-1', fonteHash: h1, snapshotHash: h1,
        verificarPDF() {},
    };
    const relatorio = planejar(f, { modelo: MODELOS[0], dirBase: dir, log: () => {} });
    const r1 = relatorio.find(r => r.chave === chave);
    const r2 = relatorio.find(r => r.chave === chave2);
    assert.equal(r1?.elegivel, true);
    assert.equal(r2?.elegivel, false);
    fs.rmSync(dir, { recursive: true });
});

// ─── Testes de main() ─────────────────────────────────────────────────────────

test('main() processa candidatura única e retorna resultado', async () => {
    const dir = tmpDir();
    const f = fonte();
    const resultados = await main(['--candidaturas=' + chave, '--dir=' + dir, '--pausa=0'], {
        carregarFonte: () => f,
        gerarBloco: gerador,
        log: () => {},
    });
    assert.equal(resultados.length, 1);
    assert.equal(resultados[0].ok, true);
    assert.equal(resultados[0].chave, chave);
    fs.rmSync(dir, { recursive: true });
});

test('main() modelo inválido lança antes de chamar Gemini', async () => {
    const f = fonte();
    await assert.rejects(
        main(['--modelo=gemini-invalido'], { carregarFonte: () => f, gerarBloco: async () => assert.fail('não chamar'), log: () => {} }),
        /Modelo inválido/,
    );
});

test('propostas restritas a temas conhecidos; tipos não-proposta não passam pela validação', async () => {
    const dir = tmpDir();
    const f = fonte();
    const ctx = prepararContexto(f, chave);
    // Gerador retorna tipo inválido
    const gerarTipoInvalido = async ({ paginas }) => ({
        afirmacoes: [{ tipo: 'biografia', tema: 'Saúde', texto: 'Nasceu em MG.',
            referencias: [{ sha256: paginas[0].sha256, pagina: paginas[0].pagina }] }],
        cobertura: paginas.map(({ sha256, pagina }) => ({ sha256, pagina })),
    });
    await assert.rejects(
        processarJob(ctx, { modelo: MODELOS[0], dirBase: dir, pausaMs: 0, gerarBloco: gerarTipoInvalido }),
        /inválid/i,
    );
    // Tema fora da lista também é rejeitado
    const gerarTemaInvalido = async ({ paginas }) => ({
        afirmacoes: [{ tipo: 'proposta', tema: 'Seguridade Social', texto: 'Reforma.',
            referencias: [{ sha256: paginas[0].sha256, pagina: paginas[0].pagina }] }],
        cobertura: paginas.map(({ sha256, pagina }) => ({ sha256, pagina })),
    });
    await assert.rejects(
        processarJob(ctx, { modelo: MODELOS[0], dirBase: dir, pausaMs: 0, gerarBloco: gerarTemaInvalido }),
        /inválid/i,
    );
    fs.rmSync(dir, { recursive: true });
});

test('rascunho já completo não é reprocessado (idempotência)', async () => {
    const dir = tmpDir();
    const f = fonte();
    const ctx = prepararContexto(f, chave);
    let chamadas = 0;
    const gerarBlocoContar = async ({ paginas }) => { chamadas++; return saidaValida(paginas); };
    await processarJob(ctx, { modelo: MODELOS[0], dirBase: dir, pausaMs: 0, gerarBloco: gerarBlocoContar });
    assert.equal(chamadas, 1);
    // Segunda execução: rascunho já existe
    await processarJob(ctx, { modelo: MODELOS[0], dirBase: dir, pausaMs: 0, gerarBloco: gerarBlocoContar });
    assert.equal(chamadas, 1, 'não deve re-chamar o Gemini se rascunho completo existe');
    fs.rmSync(dir, { recursive: true });
});
