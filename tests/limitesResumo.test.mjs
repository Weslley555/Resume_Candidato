import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { criarHandler } from '../api/resumo.js';
import { calcularChaveCache, criarRegistro, MODELOS, prepararContexto, obterResumo, publicarOffline } from '../lib/resumos.js';
import { criarGuardaResumo, ErroLimiteResumo, LIMITES_RESUMO, LUA_RESERVAR_RESUMO,
    opcoesRedis } from '../lib/limitesResumo.js';

const env = { GERACAO_PUBLICA_HABILITADA: 'true', GEMINI_API_KEY: 'SEGREDO' };
const chave = '2026_6259_MG_123';
function fixture(textos = ['Proposta de ampliar serviços.']) {
    const hash = 'a'.repeat(64);
    const doc = { sha256: hash, sha256Fonte: hash, arquivo: `assets/proposta/${chave}/plano.pdf`,
        totalPaginas: textos.length, aptoParaRascunho: true, requerRevisaoOCR: false,
        statusExtracao: 'texto_extraido', paginasPendentes: [], paginasBrancas: [],
        paginasParaRevisao: [], paginasSemTexto: [], paginasOCR: [],
        paginas: textos.map((texto, i) => ({ pagina: i + 1, texto, status: 'extraido', revisar: false })) };
    const fonte = { textos: { [chave]: [doc] }, documentos: { [chave]: { propostas: [] } },
        candidatos: { [chave]: {} }, aliases: {}, exportacao: 'run-1',
        fonteHash: 'fonte', snapshotHash: 'snapshot', verificarPDF() {} };
    return { fonte, ctx: prepararContexto(fonte, chave) };
}
const saida = paginas => ({ afirmacoes: [], cobertura: paginas.map(({ sha256, pagina }) => ({ sha256, pagina })) });

// Simulação determinística de EVAL atômico/TTL: não substitui um teste contra
// Redis real. Instâncias da guarda compartilham o mesmo armazenamento remoto.
function redisSimulado() {
    let agora = 0;
    const valores = new Map();
    const ler = k => {
        const v = valores.get(k);
        if (v && v.expira > agora) return v;
        valores.delete(k);
        return null;
    };
    return {
        chamadas: [], valores,
        avancar(s) { agora += s; },
        async eval(script, keys, args) {
            assert.equal(script, LUA_RESERVAR_RESUMO);
            this.chamadas.push({ keys, args });
            const [dia, minuto, lock] = keys.map(ler);
            if (lock) return [1, lock.expira - agora];
            if (dia?.n >= args[0]) return [2, dia.expira - agora];
            if (minuto?.n >= args[1]) return [3, minuto.expira - agora];
            valores.set(keys[2], { n: 1, expira: agora + args[2] });
            valores.set(keys[0], { n: (dia?.n ?? 0) + 1, expira: dia?.expira ?? agora + 86400 });
            valores.set(keys[1], { n: (minuto?.n ?? 0) + 1, expira: minuto?.expira ?? agora + 60 });
            return [0, 0];
        },
    };
}
function erroSeguro(status, texto) {
    return erro => {
        assert.ok(erro instanceof ErroLimiteResumo);
        assert.equal(erro.status, status);
        assert.match(erro.message, texto);
        assert.ok(erro.retryAfter > 0);
        assert.ok(!erro.message.includes('SEGREDO'));
        return true;
    };
}

test('opt-in exato e Gemini obrigatórios, inclusive com Redis injetado', async () => {
    const { ctx } = fixture();
    const redis = redisSimulado();
    for (const valor of [undefined, '', 'false', 'TRUE', '1', ' true ']) {
        await assert.rejects(criarGuardaResumo({ redis, env: { ...env, GERACAO_PUBLICA_HABILITADA: valor } })(ctx),
            erroSeguro(503, /desabilitada/));
    }
    for (const valor of [undefined, '', ' ']) {
        await assert.rejects(criarGuardaResumo({ redis, env: { ...env, GEMINI_API_KEY: valor } })(ctx),
            erroSeguro(503, /configuração/));
    }
    assert.equal(redis.chamadas.length, 0);
});

test('ausência, erro e respostas inválidas Redis sempre falham fechadas', async () => {
    const { ctx } = fixture();
    const clientes = [null, {}, { eval: async () => { throw Error('SEGREDO URL TOKEN'); } },
        ...[null, [], [0], ['0', 0], [0, 1], [4, 60], [1, -1], [2, 86401], [3, NaN], [0, 0, 0]]
            .map(resultado => ({ eval: async () => resultado }))];
    for (const redis of clientes) {
        await assert.rejects(criarGuardaResumo({ redis, env })(ctx), erroSeguro(503, /Controle/));
    }
});

test('20 chamadas concorrentes da mesma seleção admitem só uma, sem consumir quota nos bloqueios', async () => {
    const redis = redisSimulado(), { ctx } = fixture();
    const resultados = await Promise.allSettled(Array.from({ length: 20 }, () => criarGuardaResumo({ redis, env })(ctx)));
    assert.equal(resultados.filter(r => r.status === 'fulfilled').length, 1);
    for (const r of resultados.filter(r => r.status === 'rejected')) erroSeguro(429, /tentativa recente/)(r.reason);
    const { keys } = redis.chamadas[0];
    assert.ok(keys[2].endsWith(calcularChaveCache(ctx, MODELOS[0])));
    assert.equal(redis.valores.get(keys[0]).n, 1);
    assert.equal(redis.valores.get(keys[1]).n, 1);
    redis.avancar(59);
    await assert.rejects(criarGuardaResumo({ redis, env })(ctx), e => e.retryAfter === 1);
    redis.avancar(1);
    await criarGuardaResumo({ redis, env })(ctx);
});

test('quota de minuto é global entre candidaturas, seleções e instâncias', async () => {
    const redis = redisSimulado(), { ctx } = fixture();
    const resultados = await Promise.allSettled(Array.from({ length: 12 }, (_, i) =>
        criarGuardaResumo({ redis, env })({ ...ctx, chave: `candidatura-${i}` })));
    assert.equal(resultados.filter(r => r.status === 'fulfilled').length, 2);
    for (const r of resultados.filter(r => r.status === 'rejected')) erroSeguro(429, /minuto/)(r.reason);
    assert.equal(new Set(redis.chamadas.map(c => c.keys[0])).size, 1);
    assert.equal(new Set(redis.chamadas.map(c => c.keys[1])).size, 1);
    assert.equal(new Set(redis.chamadas.map(c => c.keys[2])).size, 12);
    redis.avancar(60);
    await criarGuardaResumo({ redis, env })({ ...ctx, chave: 'outra' });
});

test('lock inclui identidade da seleção/snapshot, enquanto quotas continuam globais', async () => {
    const redis = redisSimulado();
    await criarGuardaResumo({ redis, env })(fixture().ctx);
    await criarGuardaResumo({ redis, env })(fixture(['Outra seleção de texto.']).ctx);
    assert.notEqual(redis.chamadas[0].keys[2], redis.chamadas[1].keys[2]);
    assert.equal(redis.chamadas[0].keys[0], redis.chamadas[1].keys[0]);
});

test('20 admissões por janela de 24h; esgotamento diário prevalece e TTL permite nova janela', async () => {
    const redis = redisSimulado(), { ctx } = fixture();
    const guarda = criarGuardaResumo({ redis, env });
    for (let i = 0; i < 20; i++) {
        await guarda({ ...ctx, chave: `candidatura-${i}` });
        if (i % 2 === 1) redis.avancar(60);
    }
    await assert.rejects(guarda({ ...ctx, chave: 'nova' }), e => {
        erroSeguro(429, /diário/)(e);
        assert.equal(e.retryAfter, 85800);
        return true;
    });
    redis.avancar(85800);
    await guarda(ctx);
});

test('Redis usa timeout novo por requisição, retries zero e exige URL/token', () => {
    for (const config of [{}, { KV_REST_API_URL: 'https://example.test' },
        { KV_REST_API_URL: ' ', KV_REST_API_TOKEN: 'SEGREDO' }]) assert.equal(opcoesRedis(config), null);
    const config = opcoesRedis({ KV_REST_API_URL: 'https://example.test', KV_REST_API_TOKEN: 'SEGREDO' });
    assert.deepEqual(config.retry, { retries: 0 });
    assert.equal(config.enableAutoPipelining, false);
    assert.ok(config.signal() instanceof AbortSignal);
    assert.notEqual(config.signal(), config.signal());
    assert.deepEqual(LIMITES_RESUMO, { dia: 20, minuto: 2, lockSegundos: 60, redisTimeoutMs: 1000, geminiTimeoutMs: 20000 });
});

async function http(deps = {}, method = 'POST') {
    const { fonte } = fixture();
    const res = { headers: {}, setHeader(k, v) { this.headers[k] = v; },
        status(s) { this.codigo = s; return this; }, json(v) { this.body = v; return this; }, end() { return this; } };
    await criarHandler({ carregarFonte: () => fonte, cache: null, publicado: () => null,
        gerarBloco: async ({ paginas }) => saida(paginas), ...deps })(
        { method, url: `/api/resumo?id=${chave}`, body: { chave },
            get headers() { throw Error('Não depender de IP'); } }, res);
    return res;
}

test('GET e POST com cache hit não chamam guarda nem gerador; GET miss também não', async () => {
    const { ctx } = fixture();
    const registro = criarRegistro(ctx, MODELOS[0], saida(ctx.paginas));
    const proibido = () => { assert.fail('Não deveria chamar guarda/Gemini'); };
    for (const method of ['GET', 'POST']) {
        const res = await http({ cache: { get: async () => registro }, antesDeGerar: proibido, gerarBloco: proibido }, method);
        assert.equal(res.codigo, 200);
        assert.equal(res.body.cached, true);
    }
    assert.equal((await http({ antesDeGerar: proibido, gerarBloco: proibido }, 'GET')).codigo, 200);
});

test('hook injetado é bypass explícito; injetar só gerador/cache não autoriza geração', async () => {
    let chamadas = 0, guardas = 0;
    const gerarBloco = async ({ paginas }) => { chamadas++; return saida(paginas); };
    const negado = await http({ gerarBloco });
    assert.equal(negado.codigo, 503);
    assert.equal(chamadas, 0);
    assert.equal(negado.headers['Retry-After'], '60');
    const permitido = await http({ gerarBloco, antesDeGerar: async ctx => { guardas++; assert.equal(ctx.chave, chave); } });
    assert.equal(permitido.codigo, 200);
    assert.equal(chamadas, 1);
    assert.equal(guardas, 1);
});

test('HTTP preserva mensagens seguras específicas 429/503 e Retry-After', async () => {
    for (const [codigo, status, espera] of [['dia', 429, 86400], ['minuto', 429, 42], ['lock', 429, 12], ['redis', 503, 60]]) {
        const erro = new ErroLimiteResumo(codigo, status, espera);
        const res = await http({ antesDeGerar: () => { throw erro; }, gerarBloco: () => assert.fail('Gemini bloqueado') });
        assert.equal(res.codigo, status);
        assert.equal(res.body.erro, erro.message);
        assert.equal(res.headers['Retry-After'], String(espera));
        assert.deepEqual(res.body.afirmacoes, []);
    }
});

test('falha de leitura Redis não é cache miss autorizável, mesmo se EVAL pudesse funcionar', async () => {
    const res = await http({ cache: {
        get: async () => { throw Error('SEGREDO Redis'); },
        eval: async () => assert.fail('Não reservar após falha na leitura'),
    }, gerarBloco: () => assert.fail('Gemini bloqueado') });
    assert.equal(res.codigo, 503);
    assert.equal(res.body.erro, new ErroLimiteResumo('redis').message);
    assert.equal(res.headers['Retry-After'], '60');
});

test('volume acima de um bloco não consome quota nem chama Gemini', async () => {
    const { fonte } = fixture(['a'.repeat(15000), 'b'.repeat(15000)]);
    const proibido = () => assert.fail('Volume deve ser recusado antes da guarda/Gemini');
    const res = await http({ carregarFonte: () => fonte, antesDeGerar: proibido, gerarBloco: proibido });
    assert.equal(res.codigo, 200);
    assert.equal(res.body.estado, 'processamento_offline_necessario');
});

test('publicado para plano extenso é retornado mesmo acima do limite público', async () => {
    // obterResumo consulta publicado ANTES de checar maxBlocos
    // Confirma que o caminho "publicado" é percorrido para docs que não poderiam ser gerados publicamente
    const { ctx } = fixture();
    const saidaValida = paginas => ({ afirmacoes: [], cobertura: paginas.map(({ sha256, pagina }) => ({ sha256, pagina })) });
    const registro = criarRegistro(ctx, MODELOS[0], saidaValida(ctx.paginas));
    const revisao = { aprovado: true, revisor: 'Revisora', neutralidadeConferida: true,
        referenciasConferidas: true, coberturaConferida: true };
    const pub = publicarOffline(registro, ctx, revisao);
    const gerador = async ({ paginas }) => saidaValida(paginas);
    // Usa maxBlocos=0 para forçar recusa de geração pública em qualquer doc
    const r = await obterResumo(ctx, { gerar: false, publicado: () => pub, maxBlocos: 0 });
    assert.equal(r.estado, 'resumo_publicado');
    assert.equal(r.cached, true);
    // Agora testa que mesmo com gerar=true e maxBlocos=0, publicado ainda é consultado primeiro
    const r2 = await obterResumo(ctx, { gerar: true, gerarBloco: gerador,
        publicado: () => pub, maxBlocos: 0 });
    assert.equal(r2.estado, 'resumo_publicado');
});


test('Retry-After diário passa como horas, não "um minuto"', async () => {
    const erro = new ErroLimiteResumo('dia', 429, 85800);
    const res = await http({ antesDeGerar: () => { throw erro; }, gerarBloco: () => assert.fail('Gemini bloqueado') });
    assert.equal(res.codigo, 429);
    assert.equal(res.headers['Retry-After'], '85800');
    // Mensagem distingue bloqueio diário de minuteiro
    assert.match(res.body.erro, /diário/);
    assert.doesNotMatch(res.body.erro, /minuto/);
});

test('falha Gemini não faz fallback para outro modelo nem reembolsa reserva', async () => {
    const redis = redisSimulado();
    let chamadas = 0;
    const deps = { antesDeGerar: criarGuardaResumo({ redis, env }), gerarBloco: async ({ modelo }) => {
        assert.equal(modelo, MODELOS[0]); chamadas++; throw Error('SEGREDO Gemini');
    } };
    const res = await http(deps);
    assert.equal(res.codigo, 502);
    assert.equal(chamadas, 1);
    assert.ok(!JSON.stringify(res.body).includes('SEGREDO'));
    const repetido = await http(deps);
    assert.equal(repetido.codigo, 429);
    assert.equal(chamadas, 1);
    assert.equal(redis.valores.get(redis.chamadas[0].keys[0]).n, 1);
});

test('deploy limita função a 30s e Gemini declara timeout/cancelamento de 20s sem retries', () => {
    const vercel = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'));
    assert.equal(vercel.functions['api/resumo.js'].maxDuration, 30);
    const api = readFileSync(new URL('../api/resumo.js', import.meta.url), 'utf8');
    assert.match(api, /abortSignal: AbortSignal\.timeout\(LIMITES_RESUMO\.geminiTimeoutMs\)/);
    assert.match(api, /timeout: LIMITES_RESUMO\.geminiTimeoutMs/);
    assert.match(api, /retryOptions: \{ attempts: 1 \}/);
});
