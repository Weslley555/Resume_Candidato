import test from 'node:test';
import assert from 'node:assert/strict';
import candidatoPadrao, { criarHandler as criarCandidato } from '../api/candidato.js';
import listaPadrao, { criarHandler as criarLista } from '../api/lista.js';
import { congelar } from '../lib/exportacao.js';

const versao = 'a'.repeat(64);
const chaves = ['2026_6259_MG_123', '2026_6260_MG_123', '2026_6259_MG_456'];
function fixture() {
    const db = {
        'aliases_legados.json': { MG_123: null, MG_456: chaves[2] },
        'metadados.json': {
            geradoEm: '2026-09-12T20:42:58.647778+00:00', schemaVersion: '3.0',
            escopo: { ano: 2026, ufs: ['MG'], criterio: 'SG_UF', formatoMonetario: 'br', auditoria: 'SEGREDO' },
            status: 'VALIDADO_COM_AVISOS', idadeReferencia: '2026-09-12', totalCandidatos: 3, totalFotos: 0,
            arquivosFonte: [{ arquivo: 'C:\\privado\\consulta.csv', sha256: 'SEGREDO', colunas: ['SEGREDO'],
                linhasLidas: 99, geracaoDeclaradaTSE: [{ DT_GERACAO: '04/09/2026', HH_GERACAO: '19:31:18', raw: 'SEGREDO' }] },
                { arquivo: 'sem-data.csv', geracaoDeclaradaTSE: [] }],
            auditoria: 'SEGREDO', fontesOficiais: ['SEGREDO'], exportacaoRunId: 'SEGREDO',
        },
        'textos_propostas.json': { segredo: 'SEGREDO' },
        'verificacao_dados.json': { segredo: 'SEGREDO' },
    };
    for (const nome of ['candidatos', 'patrimonio', 'financeiro', 'documentos', 'fotos', 'juridico']) db[`${nome}.json`] = {};
    chaves.forEach((chave, i) => {
        db['candidatos.json'][chave] = { chave, id: chave.split('_')[3], nomeUrna: `Pessoa ${i}`, codigoEleicao: chave.split('_')[1] };
        db['patrimonio.json'][chave] = { chave, totalCentavos: i ? '0' : null, bens: [] };
        const receita = { valor_centavos: '0', nome: 'Repetido' };
        db['financeiro.json'][chave] = { chave, totalCentavos: null, receitas: [receita, { ...receita }],
            pagamentos: [{ valor_centavos: null }], doadoresOriginarios: [
                            { valor_centavos: '0', nome: 'Originário' }, { valor_centavos: '0', nome: 'Originário' },
                        ] };
        db['documentos.json'][chave] = { chave, propostas: [{ caminho: `assets/proposta/${chave}/plano.pdf` }], certidoes: [] };
        db['fotos.json'][chave] = null;
        db['juridico.json'][chave] = { chave, registrosCassacao: [] };
    });
    db['lista_busca.json'] = chaves.map(chave => ({ ...db['candidatos.json'][chave], foto: null }));
    congelar(db);
    const leituras = [];
    const estado = Object.freeze({ ok: true, status: 'VALIDADO_COM_AVISOS', runId: 'run-nao-e-hash', versao });
    const dados = { verificarExportacao: () => estado, lerJSON: nome => { leituras.push(nome); return db[nome] ?? null; } };
    return { db, dados, leituras };
}
async function chamar(handler, url, method = 'GET', headers) {
    const res = {
        headers: {}, statusCode: null, body: undefined,
        setHeader(nome, valor) { this.headers[nome.toLowerCase()] = valor; },
        status(code) { this.statusCode = code; return this; },
        json(body) { this.body = body; return this; },
        end() { return this; },
    };
    await handler({ url, method, headers }, res);
    return res;
}
function cabecalhos(res) {
    assert.equal(res.headers['cache-control'], 'no-store');
    assert.equal(res.headers['access-control-allow-origin'], '*');
    assert.equal(res.headers['access-control-allow-methods'], 'GET, OPTIONS');
    assert.equal(res.headers['access-control-allow-credentials'], undefined);
}

test('exports padrão continuam handlers; lista e detalhe usam o mesmo hash e metadados seguros', async () => {
    assert.equal(typeof candidatoPadrao, 'function');
    assert.equal(typeof listaPadrao, 'function');
    const { dados, db, leituras } = fixture();
    const lista = await chamar(criarLista(dados), '/api/lista');
    assert.equal(lista.statusCode, 200);
    assert.equal(lista.body.exportacao, versao);
    assert.strictEqual(lista.body.lista, db['lista_busca.json']);
    assert.deepEqual(Object.keys(lista.body).sort(), ['exportacao', 'lista', 'metadados']);
    const meta = lista.body.metadados;
    assert.deepEqual(Object.keys(meta).sort(), ['geradoEm', 'schemaVersion', 'escopo', 'status', 'idadeReferencia', 'totalCandidatos', 'totalFotos', 'arquivosFonte'].sort());
    assert.equal(meta.totalFotos, 0);
    assert.equal(meta.geradoEm, db['metadados.json'].geradoEm);
    assert.deepEqual(meta.arquivosFonte, [
        { arquivo: 'consulta.csv', geracaoDeclaradaTSE: [{ DT_GERACAO: '04/09/2026', HH_GERACAO: '19:31:18' }] },
        { arquivo: 'sem-data.csv', geracaoDeclaradaTSE: [] },
    ]);
    assert.ok(!JSON.stringify(lista.body).includes('SEGREDO'));
    assert.ok(!JSON.stringify(lista.body).includes('privado'));
    for (const linha of lista.body.lista) {
        const detalhe = await chamar(criarCandidato(dados), `/api/candidato?id=${linha.chave}&exportacao=${lista.body.exportacao}`);
        assert.equal(detalhe.statusCode, 200);
        assert.equal(detalhe.body.exportacao, lista.body.exportacao);
        assert.deepEqual(detalhe.body.metadados, meta);
        assert.equal(detalhe.body.candidato.nomeUrna, linha.nomeUrna);
        assert.equal(detalhe.body.idLegado, null);
        for (const [campo, arquivo] of Object.entries({ candidato: 'candidatos', patrimonio: 'patrimonio', financeiro: 'financeiro', documentos: 'documentos', foto: 'fotos', juridico: 'juridico' })) {
            assert.strictEqual(detalhe.body[campo], db[`${arquivo}.json`][linha.chave]);
        }
        cabecalhos(detalhe);
    }
    assert.ok(!leituras.includes('textos_propostas.json'));
    assert.ok(!leituras.includes('verificacao_dados.json'));
    cabecalhos(lista);
});

test('passthrough preserva null, zero, centavos string, originários e lançamentos repetidos', async () => {
    const { dados, db } = fixture();
    const antes = JSON.stringify(db);
    const res = await chamar(criarCandidato(dados), `/api/candidato?id=${chaves[0]}`);
    assert.equal(res.body.patrimonio.totalCentavos, null);
    assert.equal(res.body.financeiro.receitas.length, 2);
    assert.deepEqual(res.body.financeiro.receitas[0], res.body.financeiro.receitas[1]);
    assert.equal(res.body.financeiro.receitas[0].valor_centavos, '0');
    assert.equal(res.body.financeiro.pagamentos[0].valor_centavos, null);
    assert.equal(res.body.financeiro.doadoresOriginarios[0].valor_centavos, '0');
        assert.equal(res.body.financeiro.doadoresOriginarios.length, 2);
        assert.deepEqual(res.body.financeiro.doadoresOriginarios[0], res.body.financeiro.doadoresOriginarios[1]);
    assert.equal(res.body.foto, null);
    assert.equal(JSON.stringify(db), antes);
});

test('adapter legado só resolve alias explícito; mesmo SQ em eleições distintas não se mistura', async () => {
    const { dados } = fixture();
    const handler = criarCandidato(dados);
    const legado = await chamar(handler, '/api/candidato?id=MG_456');
    assert.equal(legado.statusCode, 200);
    assert.equal(legado.body.chave, chaves[2]);
    assert.equal(legado.body.idLegado, 'MG_456');
    for (const id of ['MG_123', 'MG_999', '2026_6259_MG_999']) {
        assert.equal((await chamar(handler, `/api/candidato?id=${id}`)).statusCode, 404);
    }
    for (const alias of [null, [chaves[0], chaves[1]], { chave: chaves[0] }, 'invalido']) {
        const h = criarCandidato({ ...dados, lerJSON: nome => nome === 'aliases_legados.json' ? { MG_123: alias } : dados.lerJSON(nome) });
        assert.equal((await chamar(h, '/api/candidato?id=MG_123')).statusCode, 404);
    }
    const semAlias = criarCandidato({ ...dados, lerJSON: nome => nome === 'aliases_legados.json' ? {} : dados.lerJSON(nome) });
    assert.equal((await chamar(semAlias, '/api/candidato?id=MG_456')).statusCode, 404);
});

test('id ausente, malformado ou repetido e URL inválida retornam 400', async () => {
    const { dados, leituras } = fixture();
    for (const url of [undefined, null, {}, '', 'http://[', '/api/candidato', '/api/candidato?id=',
        '/api/candidato?id=123', '/api/candidato?id=mg_123', '/api/candidato?id=MG_123_extra',
        '/api/candidato?id=2026_x_MG_123', '/api/candidato?id=__proto__', '/api/candidato?id=MG_-1',
        '/api/candidato?id=%20MG_123', '/api/candidato?id=%', '/api/candidato?id=%FF',
        '/api/candidato?id=MG_456&id=MG_456', '/api/candidato?id=MG_456&%69d=MG_123',
        '/api/candidato?id=MG_456&exportacao=a&exportacao=a']) {
        const res = await chamar(criarCandidato(dados), url);
        assert.equal(res.statusCode, 400, String(url));
        cabecalhos(res);
    }
    assert.deepEqual(leituras, []);
});

test('versão opcional usa igualdade exata ao hash, não runId; vazio também conflita', async () => {
    const { dados } = fixture();
    for (const valor of ['', 'run-nao-e-hash', 'b'.repeat(64), versao.toUpperCase()]) {
        const res = await chamar(criarCandidato(dados), `/api/candidato?id=${chaves[0]}&exportacao=${valor}`);
        assert.equal(res.statusCode, 409);
        assert.equal(res.body.exportacao, versao);
        cabecalhos(res);
    }
});

test('ambas APIs ignoram Host, suportam OPTIONS e rejeitam outros métodos sem ler dados', async () => {
    for (const criar of [criarLista, criarCandidato]) {
        const { dados, leituras } = fixture();
        const handler = criar(dados);
        for (const method of ['OPTIONS', 'POST', 'HEAD', 'DELETE']) {
            const res = await chamar(handler, undefined, method);
            assert.equal(res.statusCode, method === 'OPTIONS' ? 200 : 405);
            cabecalhos(res);
        }
        assert.deepEqual(leituras, []);
        const headers = { get host() { throw new Error('Host não confiável'); } };
        assert.equal((await chamar(handler, `/api/x?id=${chaves[0]}`, 'GET', headers)).statusCode, 200);
        assert.equal((await chamar(handler, 'http://[', 'GET')).statusCode, 400);
    }
});

test('snapshot inválido ou exceções falham com 503 sem expor caminhos ou motivo interno', async () => {
    for (const criar of [criarLista, criarCandidato]) {
        for (const modo of ['bloqueado', 'hash-ausente', 'hash-invalido', 'verificar-lanca', 'ler-lanca']) {
            const dados = {
                verificarExportacao() {
                    if (modo === 'verificar-lanca') throw new Error('C:/privado/auditoria.json');
                    return { ok: modo !== 'bloqueado', versao: modo === 'hash-ausente' ? undefined : modo === 'hash-invalido' ? 'run-1' : versao,
                        motivo: 'C:/privado/auditoria.json' };
                },
                lerJSON() { throw new Error('C:/privado/candidatos.json'); },
            };
            const res = await chamar(criar(dados), `/api/x?id=${chaves[0]}`);
            assert.equal(res.statusCode, 503, modo);
            assert.deepEqual(res.body, { erro: 'Exportação indisponível. Tente novamente mais tarde.' });
            cabecalhos(res);
        }
    }
    const { dados } = fixture();
    const lista = criarLista({ ...dados, lerJSON: () => null });
    assert.equal((await chamar(lista, '/api/lista')).statusCode, 503);
});

test('modo compacto omite coleções pesadas e mantém top cinco por centavos exatos', async () => {
    const { dados, db } = fixture();
    const bens = ['0', null, '9007199254740993000', '-1', '12', '50', '9007199254740993001']
        .map((valorCentavos, i) => ({ valorCentavos, nome: `bem-${i}` }));
    const patrimonio = { ...db['patrimonio.json'], [chaves[0]]: { status: 'ok', quantidade: bens.length, totalCentavos: null, bens } };
    const fin = { ...db['financeiro.json'], [chaves[0]]: { status_receitas: 'ok', total_arrecadado_centavos: '0',
        receitas: [{ valorCentavos: '0', id: 1 }, { valorCentavos: '0', id: 1 }], despesasContratadas: [],
        pagamentos: [{ valorCentavos: null }], doadoresOriginarios: [{ id: 2 }, { id: 2 }], prestadores: [] } };
    const fonte = { ...dados, lerJSON: nome => nome === 'patrimonio.json' ? patrimonio : nome === 'financeiro.json' ? fin : dados.lerJSON(nome) };
    const res = await chamar(criarCandidato(fonte), `/api/candidato?id=${chaves[0]}&exportacao=${versao}&modo=compacto`);
    assert.equal(res.statusCode, 200);
    assert.equal(Object.values(res.body.financeiro).some(Array.isArray), false);
    assert.equal(res.body.financeiro.contagens.receitas, 2);
    assert.deepEqual(res.body.patrimonio.topBens.map(x => x.nome), ['bem-6', 'bem-2', 'bem-5', 'bem-4', 'bem-0']);
    assert.equal(res.body.patrimonio.totalCentavos, null);
    assert.equal(res.body.juridico, undefined);
    assert.ok(!JSON.stringify(res.body).includes('SEGREDO'));
});

test('detalhes paginam sem deduplicar e validam seção, conjunto, página e limite', async () => {
    const { dados, db } = fixture();
    const repetido = { valorCentavos: '0', nome: 'igual' };
    const financeiro = { ...db['financeiro.json'], [chaves[0]]: { ...db['financeiro.json'][chaves[0]], receitas: [repetido, { ...repetido }, { valorCentavos: null }] } };
    const fonte = { ...dados, lerJSON: nome => nome === 'financeiro.json' ? financeiro : dados.lerJSON(nome) };
    const ok = await chamar(criarCandidato(fonte), `/api/candidato?id=${chaves[0]}&exportacao=${versao}&secao=financeiro&conjunto=receitas&pagina=1&limite=2`);
    assert.equal(ok.statusCode, 200);
    assert.deepEqual(ok.body.itens, [repetido, repetido]);
    assert.deepEqual({ total: ok.body.total, temMais: ok.body.temMais, pagina: ok.body.pagina, limite: ok.body.limite },
        { total: 3, temMais: true, pagina: 1, limite: 2 });
    const ultima = await chamar(criarCandidato(fonte), `/api/candidato?id=${chaves[0]}&secao=financeiro&conjunto=receitas&pagina=2&limite=2`);
    assert.equal(ultima.body.itens[0].valorCentavos, null);
    assert.equal(ultima.body.temMais, false);
    for (const query of ['secao=invalida', 'secao=financeiro&conjunto=x', 'secao=financeiro&conjunto=receitas&pagina=0',
        'secao=financeiro&conjunto=receitas&limite=101', 'secao=patrimonio&pagina=1&pagina=2', 'modo=compacto&secao=cadastro']) {
        assert.equal((await chamar(criarCandidato(fonte), `/api/candidato?id=${chaves[0]}&${query}`)).statusCode, 400, query);
    }
});
