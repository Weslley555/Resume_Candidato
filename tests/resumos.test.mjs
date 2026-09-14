import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
    MODELOS, VERSAO_PROMPT, sha256, carregarFonte, avaliarDocumento, prepararContexto,
    criarBlocos, validarSaida, calcularChaveCache, criarRegistro, validarRegistro,
    publicarOffline, obterResumo,
} from '../lib/resumos.js';
import { criarHandler } from '../api/resumo.js';
import { revisar } from '../scripts/revisar-resumo.mjs';

const chave = '2026_6259_MG_123';
const h1 = 'a'.repeat(64), h2 = 'b'.repeat(64);
function documento(hash = h1) {
    return { sha256: hash, sha256Fonte: hash, nome: 'Plano.pdf', arquivo: `assets/proposta/${chave}/${hash}.pdf`,
        totalPaginas: 2, aptoParaRascunho: true, requerRevisaoOCR: false, statusExtracao: 'texto_extraido',
        paginasPendentes: [], paginasBrancas: [], paginasParaRevisao: [], paginasSemTexto: [], paginasOCR: [],
        texto: 'Agregado NÃO deve ser enviado',
        paginas: [1, 2].map(pagina => ({ pagina, texto: `Proposta da página ${pagina}`, status: 'extraido', revisar: false })) };
}
function fonte(docs = [documento()]) {
    return { textos: { [chave]: docs }, documentos: { [chave]: { propostas: [] } },
        candidatos: { [chave]: {} }, aliases: { MG_123: chave, ambiguo: [chave] },
        exportacao: 'run-1', fonteHash: 'fonte', snapshotHash: 'snapshot', verificarPDF() {} };
}
const contexto = (docs, selecao) => prepararContexto(fonte(docs), chave, selecao);
function saida(paginas) {
    return { afirmacoes: paginas.filter(p => p.texto.trim()).map(p => ({ tipo: 'proposta', tema: 'Saúde', texto: 'O documento propõe ampliar serviços.',
        referencias: [{ sha256: p.sha256, pagina: p.pagina }] })), cobertura: paginas.map(({ sha256, pagina }) => ({ sha256, pagina })) };
}
const gerador = async ({ paginas }) => saida(paginas);
function cacheMemoria() {
    const map = new Map();
    return { map, get: async k => map.get(k), set: async (k, v) => map.set(k, structuredClone(v)) };
}
async function http(req, deps = {}) {
    const res = { headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(s) { this.codigo = s; return this; },
        json(v) { this.body = v; return this; }, end() { return this; } };
    await criarHandler({ carregarFonte: () => fonte(), cache: null, publicado: () => null, gerarBloco: gerador, antesDeGerar: async () => {}, ...deps })({ url: '/api/resumo', ...req }, res);
    return res;
}

function runtimeMock() {
    const s = snapshot();
    const dados = Object.fromEntries(['textos_propostas.json', 'documentos.json', 'candidatos.json', 'aliases_legados.json']
        .map(nome => [nome, JSON.parse(s.opts.ler(path.join(s.opts.raiz, 'data', nome)))]));

    const controles = Object.fromEntries(['EXPORTACAO_VALIDADA.json', 'manifesto_sha256.json']
        .map(nome => [nome, JSON.parse(s.opts.ler(path.join(s.opts.raiz, 'public', nome)))]));
    function congelar(v) {
        if (v && typeof v === 'object') { Object.values(v).forEach(congelar); Object.freeze(v); }
        return v;
    }
    return congelar({ ok: true, status: s.marcador.status, runId: s.marcador.runId,
        versao: s.marcador.manifestoSHA256, raiz: '/runtime-sem-assets', runtime: true, dados, controles,
        lerBytes() { throw Error('Consumidor não deve copiar JSONs nem solicitar PDFs'); } });
}

test('runtime sem PDFs compartilha dados imutáveis e permite gerar, consultar e publicar', async () => {
    const snapshot = runtimeMock();
    const carregar = () => carregarFonte({ obterFonte: () => snapshot });
    const f = carregar();
    assert.equal(f.textos, snapshot.dados['textos_propostas.json']);
    assert.equal(carregar().textos, f.textos);
    assert.equal(Object.isFrozen(f), true);
    assert.throws(() => { f.textos[chave][0].paginas[0].texto = 'alteração'; }, TypeError);
    const cache = cacheMemoria();
    const post = await http({ method: 'POST', body: { chave } }, { carregarFonte: carregar, cache });
    assert.equal(post.body.estado, 'rascunho_gerado');
    const get = await http({ method: 'GET', url: '/api/resumo?id=' + chave }, { carregarFonte: carregar, cache });
    assert.equal(get.body.cached, true);
    const gravados = [];
    revisar(['draft.json', 'publicado.json', 'Revisora', '--aprovar', '--conferi-neutralidade', '--conferi-referencias', '--conferi-cobertura'], {
        carregar, ler: () => JSON.stringify(post.body), escrever: (nome, bytes) => gravados.push(JSON.parse(bytes)),
    });
    const pub = await http({ method: 'GET', url: '/api/resumo?id=' + chave }, { carregarFonte: carregar, publicado: () => gravados[0] });
    assert.equal(pub.body.estado, 'resumo_publicado');
    assert.equal(pub.body.exportacao, snapshot.versao);
});
test('runtime rejeita hash/caminho/candidatura divergente sem tentar ler PDF', () => {
    const snapshot = runtimeMock();
    const f = carregarFonte({ obterFonte: () => snapshot });
    const d = f.textos[chave][0];
    assert.doesNotThrow(() => f.verificarPDF(d, chave));
    for (const alteracao of [{ sha256: h2 }, { arquivo: '../outro.pdf' },
        { arquivo: `assets/proposta/2026_1_BR_9/${d.sha256}.pdf` }]) {
        assert.throws(() => f.verificarPDF({ ...d, ...alteracao }, chave), /Vínculo/);
    }
    assert.throws(() => f.verificarPDF(d, '2026_1_BR_9'), /Vínculo/);
    assert.throws(() => carregarFonte({ obterFonte: () => ({ ...snapshot, versao: h2 }) }), /divergente/);
});
test('runtime corrompido rejeitado pelo loader resulta em erro_geracao, sem fallback', async () => {
    for (const obterFonte of [() => null, () => ({ ok: false }), () => { throw Error('Runtime inválido: recibo de build divergente'); }]) {
        assert.throws(() => carregarFonte({ obterFonte }));
        const r = await http({ method: 'POST', body: { chave } }, { carregarFonte: () => carregarFonte({ obterFonte }) });
        assert.equal(r.codigo, 503);
        assert.equal(r.body.estado, 'erro_geracao');
        assert.deepEqual(r.body.afirmacoes, []);
    }
    assert.throws(() => carregarFonte({ raiz: '/nao-usar-como-fallback' }), /explicitamente/);
});

// Um filesystem em memória permite testar hashes dos bytes completos sem alterar /data.
function snapshot() {
    const raiz = path.resolve('snapshot-mock');
    const files = new Map();
    const manifesto = {};
    const put = (p, v) => files.set(path.join(raiz, p), Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)));
    const pdfBytes = 'PDF sintético apenas para verificar integridade';
    const pdf = documento(sha256(pdfBytes));
    put('public/' + pdf.arquivo, pdfBytes);
    manifesto[pdf.arquivo] = pdf.sha256;
    for (const [nome, valor] of Object.entries({ 'textos_propostas.json': { [chave]: [pdf] },
        'documentos.json': { [chave]: { propostas: [{ sha256: pdf.sha256, caminho: pdf.arquivo }] } },
        'candidatos.json': fonte().candidatos, 'aliases_legados.json': fonte().aliases })) {
        put('data/' + nome, valor);
        manifesto['data/' + nome] = sha256(files.get(path.join(raiz, 'data', nome)));
    }
    put('public/manifesto_sha256.json', manifesto);
    const marcador = { status: 'VALIDADA_TECNICAMENTE', runId: 'run-1', manifestoSHA256: sha256(files.get(path.join(raiz, 'public/manifesto_sha256.json'))) };
    put('public/EXPORTACAO_VALIDADA.json', marcador);
    return { files, put, marcador, pdf, opts: { raiz, existe: () => false, verificar: () => ({ ok: true, runId: 'run-1' }),
        ler(p) { if (!files.has(p)) throw new Error('ENOENT'); return files.get(p); } } };
}

test('fonte canônica atual validada, sem fallback e com versao preferida', () => {
    const s = snapshot();
    assert.equal(carregarFonte(s.opts).textos[chave].length, 1);
    const versao = s.marcador.manifestoSHA256;
    assert.equal(carregarFonte({ ...s.opts, verificar: () => ({ ok: true, runId: 'run-1', versao }) }).exportacao, versao);
    assert.throws(() => carregarFonte({ ...s.opts, verificar: () => ({ ok: true, runId: 'run-1', versao: h2 }) }));
    s.put('data/textos_propostas.json', {});
    assert.throws(() => carregarFonte(s.opts), /manifesto/);
    s.put('data/propostas.json', fonte().textos);
    assert.throws(() => carregarFonte(s.opts), /manifesto/);
});
test('snapshot rejeita status desconhecido, hash manifesto, run e validação global', () => {
    for (const alteracao of [{ status: 'NOVO' }, { manifestoSHA256: h1 }, { runId: 'outro' }]) {
        const s = snapshot(); s.put('public/EXPORTACAO_VALIDADA.json', { ...s.marcador, ...alteracao });
        assert.throws(() => carregarFonte(s.opts));
    }
    assert.throws(() => carregarFonte({ ...snapshot().opts, verificar: () => ({ ok: false }) }));
});
test('snapshot relê fonte inteira em instância quente e detecta troca durante leitura', () => {
    const s = snapshot(); carregarFonte(s.opts);
    s.put('data/textos_propostas.json', JSON.stringify(fonte().textos) + ' ');
    assert.throws(() => carregarFonte(s.opts));
    const t = snapshot(); let leituras = 0;
    assert.throws(() => carregarFonte({ ...t.opts, ler(p) {
        if (p.endsWith('EXPORTACAO_VALIDADA.json') && ++leituras === 2) return Buffer.from('{}');
        return t.opts.ler(p);
    } }), /alterada/);
});
test('ausência não infere inexistência de proposta pelo cargo', () => {
    assert.equal(contexto([]).resposta.estado, 'documento_indisponivel');
});
test('multi PDFs nunca seleciona silenciosamente o apto', () => {
    const pendente = documento(h2); pendente.aptoParaRascunho = false; pendente.paginasPendentes = [2];
    const ctx = contexto([documento(), pendente]);
    assert.equal(ctx.resposta.estado, 'revisao_necessaria'); assert.equal(ctx.resposta.documentos.length, 2);
    assert.equal(contexto([documento(), pendente], [h1, h2]).resposta.estado, 'extracao_pendente');
    assert.deepEqual(contexto([documento(), pendente], [h1]).base.documentosSelecionados, [h1]);
    for (const s of [[], [h1, h1], ['c'.repeat(64)], 'todos', null]) assert.throws(() => contexto([documento()], s));
});
test('PDF no inventário sem extração aparece e bloqueia seleção completa', () => {
    const f = fonte(); f.documentos[chave].propostas.push({ sha256: h2, nome: 'Outro.pdf' });
    assert.equal(prepararContexto(f, chave).resposta.documentos.length, 2);
    assert.equal(prepararContexto(f, chave, [h1, h2]).resposta.estado, 'extracao_pendente');
});
test('controles ausentes são desconhecidos, OCR apto mantém alerta', () => {
    for (const campo of ['aptoParaRascunho', 'requerRevisaoOCR', 'paginasPendentes', 'paginasBrancas', 'paginasParaRevisao', 'paginasSemTexto', 'paginasOCR', 'statusExtracao']) {
        const d = documento(); delete d[campo]; assert.notEqual(avaliarDocumento(d), 'apto', campo);
    }
    const d = documento(); d.requerRevisaoOCR = true; d.paginas[0].status = 'ocr_revisar'; d.paginas[0].revisar = true;
    assert.equal(contexto([d]).avisoRevisaoOCR, true);
});
test('páginas faltantes, duplicadas, vazias e status desconhecido bloqueiam', () => {
    for (const alterar of [d => d.paginas.pop(), d => d.paginas[1].pagina = 1,
        d => d.paginas[1].texto = '', d => d.paginas[1].status = 'desconhecido', d => d.totalPaginas = undefined]) {
        const d = documento(); alterar(d); assert.notEqual(avaliarDocumento(d), 'apto');
    }
});
test('brancas confirmadas são cobertas, não podem fundamentar afirmações', () => {
    const d = documento(); d.paginas[1] = { pagina: 2, texto: '', status: 'pagina_branca', revisar: false }; d.paginasBrancas = [2];
    const ctx = contexto([d]); assert.equal(ctx.paginas.length, 2);
    const out = saida(ctx.paginas); validarSaida(out, ctx.paginas);
    out.afirmacoes[0].referencias[0].pagina = 2;
    assert.throws(() => validarSaida(out, ctx.paginas));
});
test('blocos preservam todas as páginas e o texto selecionado sem truncar', () => {
    const d = documento(); d.paginas[0].texto = 'x'.repeat(10000); d.paginas[1].texto = 'y'.repeat(10000);
    const ctx = contexto([d]); const blocos = criarBlocos(ctx.paginas, 15000);
    assert.equal(blocos.length, 2); assert.deepEqual(blocos.flat(), ctx.paginas);
    assert.throws(() => criarBlocos(ctx.paginas, 100), /sem truncamento/);
});
test('valida JSON estrito, enum, referências reais e cobertura exata', () => {
    const ctx = contexto();
    for (const alterar of [o => o.afirmacoes[0].tipo = 'opiniao',
        ...['diagnostico', 'critica', 'realizacao_alegada'].map(tipo => o => o.afirmacoes[0].tipo = tipo),
        o => delete o.afirmacoes[0].tema, o => o.afirmacoes[0].tema = 'Biografia',
        o => o.afirmacoes[0].texto = '<script>',
        o => o.afirmacoes[0].referencias = [], o => o.afirmacoes[0].referencias[0].sha256 = h2,
        o => o.afirmacoes[0].referencias[0].pagina = 99, o => o.cobertura.pop(),
        o => o.cobertura[1] = o.cobertura[0], o => o.resumo = 'Texto livre', o => o.afirmacoes[0].extra = true]) {
        const out = saida(ctx.paginas); alterar(out); assert.throws(() => validarSaida(out, ctx.paginas));
    }
    assert.throws(() => validarSaida('Texto livre', ctx.paginas));
});
test('cache inclui candidatura completa, extração inteira, estados, seleção, prompt e modelo', () => {
    const ctx = contexto(); const key = calcularChaveCache(ctx, MODELOS[0]);
    for (const alterar of [c => c.chave = '2022_1_MG_123', c => c.docs[0].paginas[0].texto += ' revisão',
        c => c.docs[0].paginasParaRevisao = [2], c => c.fonte.fonteHash = 'nova', c => c.fonte.exportacao = 'run-2',
        c => c.docs[0].sha256 = h2]) {
        const c = contexto(); alterar(c); assert.notEqual(calcularChaveCache(c, MODELOS[0]), key);
    }
    assert.notEqual(calcularChaveCache(ctx, MODELOS[1]), key);
    assert.notEqual(calcularChaveCache(ctx, MODELOS[0], VERSAO_PROMPT + '2'), key);
    assert.notEqual(calcularChaveCache(contexto([documento(), documento(h2)], [h1]), MODELOS[0]), key);
});
test('fallback reinicia blocos e armazena sob modelo efetivo; GET encontra fallback', async () => {
    const d = documento(); d.paginas.forEach(p => p.texto = 'x'.repeat(13000));
    const ctx = contexto([d]); const cache = cacheMemoria(); const calls = [];
    const gerarBloco = async ({ modelo, paginas }) => {
        calls.push([modelo, paginas[0].pagina]);
        if (modelo === MODELOS[0] && paginas[0].pagina === 2) throw new Error('falha');
        return saida(paginas);
    };
    const r = await obterResumo(ctx, { gerar: true, gerarBloco, cache, publicado: () => null });
    assert.equal(r.estado, 'rascunho_gerado'); assert.equal(r.modelo, MODELOS[1]); assert.equal(r.afirmacoes.length, 1);
        assert.equal(r.afirmacoes[0].referencias.length, 2);
    assert.deepEqual(calls, [[MODELOS[0], 1], [MODELOS[0], 2], [MODELOS[1], 1], [MODELOS[1], 2]]);
    assert.equal(cache.map.has(calcularChaveCache(ctx, MODELOS[0])), false);
    const hit = await obterResumo(ctx, { cache, publicado: () => null });
    assert.equal(hit.cached, true); assert.equal(hit.modelo, MODELOS[1]);
});
test('cache antigo ou publicação forjada em Redis é ignorado; falha de cache não impede rascunho', async () => {
    const ctx = contexto();
    for (const valor of ['resumo antigo', { estado: 'resumo_publicado' }]) {
        const r = await obterResumo(ctx, { cache: { get: async () => valor }, publicado: () => null });
        assert.equal(r.cached, false); assert.equal(r.estado, 'resumo_nao_preparado');
    }
    const r = await obterResumo(ctx, { gerar: true, gerarBloco: gerador, publicado: () => null,
        cache: { get() { throw Error(); }, set() { throw Error(); } } });
    assert.equal(r.estado, 'rascunho_gerado');
});
test('falha de um bloco nunca salva nem devolve rascunho parcial', async () => {
    const cache = cacheMemoria();
    await assert.rejects(obterResumo(contexto(), { gerar: true, cache, publicado: () => null, gerarBloco: async () => 'livre' }));
    assert.equal(cache.map.size, 0);
});
test('publicação exige revisão explícita e vinculada ao conteúdo; somente fonte local é autoridade', async () => {
    const ctx = contexto(); const registro = criarRegistro(ctx, MODELOS[0], saida(ctx.paginas));
    assert.throws(() => publicarOffline(registro, ctx, { aprovado: true }));
    const revisao = { aprovado: true, revisor: 'Revisora', neutralidadeConferida: true, referenciasConferidas: true, coberturaConferida: true };
    const pub = publicarOffline(registro, ctx, revisao);
    const r = await obterResumo(ctx, { publicado: () => ({ ...pub, resumo: 'não vazar' }) });
    assert.equal(r.estado, 'resumo_publicado'); assert.equal(r.resumo, undefined);
    pub.afirmacoes[0].texto = 'Alterado'; assert.throws(() => validarRegistro(pub, ctx, MODELOS[0], true));
    const d = documento(); d.requerRevisaoOCR = true; const ocr = contexto([d]);
    const draft = criarRegistro(ocr, MODELOS[0], saida(ocr.paginas));
    assert.throws(() => publicarOffline(draft, ocr, revisao));
    assert.equal(publicarOffline(draft, ocr, { ...revisao, ocrConferido: true }).estado, 'resumo_publicado');
    assert.throws(() => revisar([]), /Uso/);
});
test('GET usa id e não gera; POST aceita chave ou alias; métodos e JSON inválidos', async () => {
    const get = await http({ method: 'GET', url: '/api/resumo?id=' + chave }, { gerarBloco() { throw Error('não chamar'); } });
    assert.equal(get.codigo, 200); assert.equal(get.body.cached, false);
    for (const body of [{ chave }, { id_candidato: 'MG_123' }]) {
        const r = await http({ method: 'POST', body }); assert.equal(r.body.estado, 'rascunho_gerado');
    }
    assert.equal((await http({ method: 'POST', body: '{' })).codigo, 400);
    assert.equal((await http({ method: 'GET' })).codigo, 400);
    assert.equal((await http({ method: 'PUT' })).codigo, 405);
    assert.equal((await http({ method: 'OPTIONS' })).codigo, 204);
    assert.equal((await http({ method: 'POST', body: { id_candidato: 'ambiguo' } })).codigo, 404);
});
test('exportacao opcional em query/body compara ambas e devolve 409 antes da geração', async () => {
    for (const req of [{ method: 'GET', url: '/api/resumo?id=' + chave + '&exportacao=antiga' },
        { method: 'POST', body: { chave, exportacao: 'antiga' } },
        { method: 'POST', url: '/api/resumo?exportacao=antiga', body: { chave, exportacao: 'run-1' } },
        { method: 'POST', body: { chave, exportacao: null } }]) {
        const r = await http(req); assert.equal(r.codigo, 409); assert.deepEqual(r.body.afirmacoes, []);
    }
    assert.equal((await http({ method: 'POST', body: { chave, exportacao: 'run-1' } })).codigo, 200);
});
test('POST remoto não pode publicar, revisar ou injetar afirmações', async () => {
    for (const campo of ['publicar', 'revisao', 'afirmacoes', 'estado', 'modelo']) {
        assert.equal((await http({ method: 'POST', body: { chave, [campo]: true } })).codigo, 400);
    }
});
test('API falha fechada em fonte inválida, sem expor erro interno', async () => {
    const r = await http({ method: 'POST', body: { chave } }, { carregarFonte() { throw Error('segredo interno'); } });
    assert.equal(r.codigo, 503); assert.equal(r.body.estado, 'erro_geracao'); assert.doesNotMatch(r.body.erro, /segredo/);
});

test('sha256Fonte é opcional e pode identificar outra versão sem mudar referências', () => {
    const original = contexto();
    const registro = criarRegistro(original, MODELOS[0], saida(original.paginas));
    for (const valor of [undefined, h2]) {
        const d = documento();
        if (valor === undefined) delete d.sha256Fonte;
        else d.sha256Fonte = valor;
        assert.equal(avaliarDocumento(d), 'apto');
        const ctx = contexto([d]);
        assert.ok(ctx.paginas.every(p => p.sha256 === h1));
        assert.notEqual(calcularChaveCache(ctx, MODELOS[0]), registro.cacheKey);
        assert.throws(() => validarRegistro(registro, ctx, MODELOS[0]), /incompatível/);
    }
});
function visualRevisada() {
    const d = documento();
    d.paginas[1] = { pagina: 2, texto: '', status: 'pagina_visual_sem_texto', metodo: 'revisao_visual_sha256', revisar: false };
    d.paginasSemTexto = [2];
    return d;
}
test('página visual revisada real participa da cobertura, sem inventar aprovação ou afirmação', async () => {
    const d = visualRevisada();
    assert.equal(avaliarDocumento(d), 'apto');
    const ctx = contexto([d]);
    const r = await obterResumo(ctx, { gerar: true, gerarBloco: gerador, publicado: () => null });
    assert.equal(r.estado, 'rascunho_gerado');
    assert.equal(r.revisaoNecessaria, true);
    assert.equal(r.cobertura.length, 2);
    assert.equal(r.afirmacoes.length, 1);
    r.afirmacoes[0].referencias = [{ sha256: h1, pagina: 2 }];
    assert.throws(() => validarSaida({ afirmacoes: r.afirmacoes, cobertura: r.cobertura }, ctx.paginas));
    for (const alterar of [d => d.paginas[1].revisar = true, d => delete d.paginas[1].revisar,
        d => d.paginas[1].metodo = 'texto_pdf', d => d.paginas[1].status = 'aprovada',
        d => d.paginasPendentes = [2], d => d.paginasParaRevisao = [2], d => d.paginasSemTexto = []]) {
        const outro = visualRevisada(); alterar(outro); assert.notEqual(avaliarDocumento(outro), 'apto');
    }
});
test('snapshot fixado fornece JSON e PDF; falta ou corrupção não usa pacote raiz como fallback', () => {
    const s = snapshot();
    const versao = s.marcador.manifestoSHA256;
    const raizSnapshot = path.join(s.opts.raiz, 'snapshots', versao);
    const arquivos = new Map([...s.files].map(([p, b]) => [path.join(raizSnapshot, path.relative(s.opts.raiz, p)), b]));
    const lidos = [];
    const opts = { ...s.opts, existe: p => p === path.join(s.opts.raiz, 'snapshots', 'ativo.json'),
        verificar: () => ({ ok: true, runId: 'run-1', versao }),
        ler(p) { lidos.push(p); if (!arquivos.has(p)) throw Error('Arquivo ausente'); return arquivos.get(p); } };
    const f = carregarFonte(opts);
    const ctx = prepararContexto(f, chave);
    assert.ok(ctx.paginas.length > 0);
    assert.ok(lidos.every(p => p.startsWith(raizSnapshot + path.sep)));
    const pdfPath = path.join(raizSnapshot, 'public', s.pdf.arquivo);
    arquivos.set(pdfPath, Buffer.from('PDF adulterado'));
    assert.throws(() => prepararContexto(f, chave), /PDF/);
    arquivos.delete(pdfPath);
    assert.throws(() => prepararContexto(f, chave), /PDF/);
    arquivos.delete(path.join(raizSnapshot, 'data', 'textos_propostas.json'));
    assert.throws(() => carregarFonte(opts), /ausente/);
});
test('CLI offline valida o snapshot correto, mantém wx e recusa rascunho de outra versão', () => {
    const s = snapshot();
    const opts = { ...s.opts, verificar: () => ({ ok: true, runId: 'run-1', versao: s.marcador.manifestoSHA256 }) };
    const f = carregarFonte(opts);
    const ctx = prepararContexto(f, chave);
    const registro = criarRegistro(ctx, MODELOS[0], saida(ctx.paginas));
    const args = ['entrada.json', 'saida.json', 'Revisora', '--aprovar', '--conferi-neutralidade', '--conferi-referencias', '--conferi-cobertura'];
    const escritas = [];
    const deps = { carregar: () => carregarFonte(opts), ler: () => JSON.stringify(registro),
        escrever: (...args) => escritas.push(args) };
    assert.match(revisar(args, deps), /data\/resumos_publicados\//);
    const publicado = JSON.parse(escritas[0][1]);
    assert.equal(publicado.estado, 'resumo_publicado');
    assert.equal(publicado.exportacao, f.exportacao);
    assert.equal(escritas[0][2].flag, 'wx');
    validarRegistro(publicado, ctx, MODELOS[0], true);
    const alterada = { ...f, snapshotHash: h2, exportacao: h2 };
    assert.throws(() => revisar(args, { ...deps, carregar: () => alterada }), /incompatível/);
    assert.equal(escritas.length, 1);
});
test('402 estados distintos: OCR apto vs extração pendente vs processamento_offline_necessario', async () => {
    const ctx = contexto();
    // Documento extenso: retorna o novo estado distinto
    const d = documento();
    d.paginas[0].texto = 'a'.repeat(15000);
    d.paginas[1].texto = 'b'.repeat(15000);
    d.totalPaginas = 2;
    const ctxExterno = contexto([d]);
    const r = await obterResumo(ctxExterno, { gerar: true, gerarBloco: gerador, publicado: () => null, maxBlocos: 1 });
    assert.equal(r.estado, 'processamento_offline_necessario');
    // Motivo menciona o script CLI, não confunde com falta de revisão
    assert.match(r.motivo, /gerar-rascunhos/);
    // extracao_pendente: estado distinto de revisao_necessaria
    const pendente = documento('c'.repeat(64));
    pendente.aptoParaRascunho = false;
    pendente.paginasPendentes = [1];
    const ctxPendente = contexto([pendente], ['c'.repeat(64)]);
    assert.equal(ctxPendente.resposta?.estado, 'extracao_pendente');
    // extracao_pendente NÃO é revisao_necessaria
    assert.notEqual(ctxPendente.resposta?.estado, 'revisao_necessaria');
    // documento_indisponivel: estado distinto de ausente no snapshot
    assert.equal(contexto([]).resposta.estado, 'documento_indisponivel');
    assert.notEqual(contexto([]).resposta.estado, 'extracao_pendente');
});

test('mensagens coerentes quando nenhum conteúdo foi gerado', async () => {
    // rascunho_ausente não é falha de geração; GET sem gerar devolve estado claro
    const ctx = contexto();
    const r = await obterResumo(ctx, { gerar: false, publicado: () => null });
    assert.equal(r.estado, 'resumo_nao_preparado');
    assert.equal(r.motivo, 'rascunho_ausente');
    assert.deepEqual(r.afirmacoes, []);
    // Nenhum campo finge ter conteúdo
    assert.equal(r.resumo, undefined);
    assert.equal(r.revisaoNecessaria, true);
    // processamento_offline_necessario não usa estado revisao_necessaria
    const d = documento(); d.paginas[0].texto = 'a'.repeat(15000); d.paginas[1].texto = 'b'.repeat(15000);
    const ctxGrande = contexto([d]);
    const rGrande = await obterResumo(ctxGrande, { gerar: true, gerarBloco: gerador, publicado: () => null, maxBlocos: 1 });
    assert.equal(rGrande.estado, 'processamento_offline_necessario');
    assert.notEqual(rGrande.estado, 'revisao_necessaria');
    assert.notEqual(rGrande.estado, 'erro_geracao');
});
test('API retorna erro_geracao vazio para falhas de geração e publicação inválida', async () => {
    for (const status of [429, 503, 502]) {
        const r = await http({ method: 'POST', body: { chave } }, {
            gerarBloco() { throw Object.assign(Error('Detalhe privado'), { status }); },
        });
        assert.equal(r.codigo, status);
        assert.equal(r.body.estado, status === 429 ? 'bloqueio_quota' : status === 503 ? 'erro_geracao' : 'falha_geracao');
        assert.deepEqual(r.body.afirmacoes, []);
        assert.doesNotMatch(r.body.erro, /privado/);
    }
    const invalido = await http({ method: 'POST', body: { chave } }, { gerarBloco: async () => 'texto livre' });
    assert.equal(invalido.codigo, 502);
    assert.equal(invalido.body.estado, 'falha_geracao');
    const ctx = contexto();
    const registro = criarRegistro(ctx, MODELOS[0], saida(ctx.paginas));
    for (const alteracao of [{ chave: '2026_6259_MG_999' }, { exportacao: 'run-2' },
        { cacheKey: 'resumos:v1:' + h2 }, { documentosSelecionados: [h2] }, { modelo: MODELOS[1] }]) {
        const adulterado = { ...registro, ...alteracao, estado: 'resumo_publicado' };
        const r = await http({ method: 'GET', url: '/api/resumo?id=' + chave }, { publicado: () => adulterado });
        assert.equal(r.codigo, 502);
        assert.equal(r.body.estado, 'falha_geracao');
        assert.deepEqual(r.body.afirmacoes, []);
        const miss = await obterResumo(ctx, { cache: { get: async () => ({ ...registro, ...alteracao }) }, publicado: () => null });
        assert.equal(miss.cached, false);
    }
    const nulo = await http({ method: 'POST', body: { chave } }, { carregarFonte() { throw null; } });
    assert.equal(nulo.codigo, 503);
    assert.equal(nulo.body.estado, 'erro_geracao');
});

