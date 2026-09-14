import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { ARQUIVOS_DADOS, sha256, validarExportacao, importarExportacao, carregarSnapshot } from '../lib/exportacao.js';
import { build } from '../scripts/build.mjs';
import { carregarFonteSnapshot, carregarRuntime, gerarRuntime } from '../lib/runtimeSnapshot.js';

const chave = '2026_6259_MG_123';
const cacheURL = new URL('../lib/jsonCache.js', import.meta.url).href;
function gravar(raiz, nome, valor) {
    fs.mkdirSync(path.dirname(path.join(raiz, nome)), { recursive: true });
    fs.writeFileSync(path.join(raiz, nome), typeof valor === 'string' || Buffer.isBuffer(valor) ? valor : JSON.stringify(valor));
}
function ler(raiz, nome) { return JSON.parse(fs.readFileSync(path.join(raiz, nome))); }
function indicePublicado(raiz) {
    const ponteiro = ler(raiz, 'dist/exportacao.json');
    const bytes = fs.readFileSync(path.join(raiz, 'dist', ponteiro.indice.arquivo));
    assert.equal(sha256(bytes), ponteiro.indice.sha256);
    return JSON.parse(bytes);
}
function selar(raiz, runId = 'run-1', status = 'VALIDADA_TECNICAMENTE', extras = {}) {
    const manifesto = {};
    for (const nome of ARQUIVOS_DADOS) {
        const arquivo = path.join(raiz, 'data', nome);
        if (fs.existsSync(arquivo)) manifesto[`data/${nome}`] = sha256(fs.readFileSync(arquivo));
    }
    function visitar(pasta) {
        for (const e of fs.readdirSync(path.join(raiz, 'public', pasta), { withFileTypes: true })) {
            const nome = `${pasta}/${e.name}`;
            if (e.isDirectory()) visitar(nome);
            else manifesto[nome] = sha256(fs.readFileSync(path.join(raiz, 'public', nome)));
        }
    }
    visitar('assets');
    gravar(raiz, 'public/manifesto_sha256.json', { ...manifesto, ...extras });
    gravar(raiz, 'public/EXPORTACAO_VALIDADA.json', { status, runId,
        manifestoSHA256: sha256(fs.readFileSync(path.join(raiz, 'public/manifesto_sha256.json'))) });
}
function fixture(t, runId = 'run-1') {
    const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'exportacao-'));
    t.after(() => fs.rmSync(raiz, { recursive: true, force: true }));
    const pdfBytes = Buffer.from('%PDF-1.4 fixture');
    const hash = sha256(pdfBytes);
    const arquivo = `assets/proposta/${chave}/${hash}.pdf`;
    gravar(raiz, `public/${arquivo}`, pdfBytes);
    const c = { id: '123', chave, uf: 'MG', anoEleicao: '2026', codigoEleicao: '6259',
        numeroUrna: '10', nomeUrna: 'TESTE', nomeCompleto: 'CANDIDATO TESTE', cargo: 'GOVERNADOR', partido: 'TESTE' };
    const escopo = { ano: 2026, ufs: ['MG'] };
    const dados = {
        'candidatos.json': { [chave]: c },
        'aliases_legados.json': { MG_123: chave },
        'documentos.json': { [chave]: { propostas: [{ nome: 'plano.pdf', caminho: arquivo, sha256: hash }], certidoes: [] } },
        'financeiro.json': { [chave]: { prestadores: [], receitas: [], despesasContratadas: [], pagamentos: [], doadoresOriginarios: [] } },
        'fotos.json': { [chave]: { arquivo: null, status: 'sem_arquivo' } },
        'juridico.json': { [chave]: { status: 'sem_registros', motivoCassacao: [], registrosCassacao: [] } },
        'patrimonio.json': { [chave]: { status: 'sem_registros', bens: [], quantidade: 0 } },
        'textos_propostas.json': { [chave]: [{ nome: 'plano.pdf', arquivo, sha256: hash, sha256Fonte: hash, texto: 'Plano',
            totalPaginas: 1, paginas: [{ pagina: 1, texto: 'Plano', metodo: 'nativo', status: 'extraido', revisar: false }],
            statusExtracao: 'texto_extraido', geradoPorIA: false, aptoParaRascunho: true }] },
        'lista_busca.json': [{ ...c, nome: 'TESTE', nomeBusca: 'teste', foto: null }],
        'metadados.json': { schemaVersion: '3.0', geradoEm: '2026-09-12T00:00:00Z', status: 'VALIDADO_COM_AVISOS',
            totalCandidatos: 1, totalFotos: 0, escopo, arquivosFonte: [] },
        'verificacao_dados.json': { schemaVersion: '3.0', status: 'VALIDADO_COM_AVISOS', escopo, fontes: [], eventos: [], reconciliacao: {} },
    };
    for (const [nome, valor] of Object.entries(dados)) gravar(raiz, `data/${nome}`, valor);
    for (const nome of ['index.html', 'privacidade.html', 'termos-de-uso.html', 'script.js', 'style.css']) gravar(raiz, `public/${nome}`, 'fixture');
    gravar(raiz, 'public/frontend-helpers.mjs', 'export const fixture = true;');
    gravar(raiz, 'fonts/Open_Sans/OpenSans-VariableFont_wdth,wght.ttf', 'font fixture');
    gravar(raiz, 'public/lista_busca.json', [{ legado: true }]);
    gravar(raiz, 'public/dados_candidatos.json', { privado: true });
    gravar(raiz, 'public/auditoria/segredo.json', { privado: true });
    selar(raiz, runId);
    return raiz;
}
function alterar(raiz, nome, callback) {
    const x = ler(raiz, `data/${nome}.json`);
    callback(x);
    gravar(raiz, `data/${nome}.json`, x);
    selar(raiz);
}

test('pacote atual completo, controles e nome canônico', t => {
    const raiz = fixture(t);
    const s = carregarSnapshot(raiz);
    assert.equal(s.ok, true);
    assert.equal(s.versao, s.controles['EXPORTACAO_VALIDADA.json'].manifestoSHA256);
});

test('allowlist explícita de status do marcador e auditoria', t => {
    const raiz = fixture(t);
    for (const status of ['VALIDADA_TECNICAMENTE', 'VALIDADO', 'VALIDADO_COM_AVISOS']) {
        selar(raiz, 'run-1', status);
        assert.equal(validarExportacao(raiz).status, status);
    }
    for (const status of ['BLOQUEADA', 'INCOMPLETA', 'REJEITADA', 'NOVO', null]) {
        selar(raiz, 'run-1', status);
        assert.throws(() => validarExportacao(raiz), /status/);
    }
    alterar(raiz, 'verificacao_dados', x => { x.status = 'BLOQUEADA'; });
    assert.throws(() => validarExportacao(raiz), /status/);
});

test('hash do manifesto no marcador, JSONs e assets são obrigatórios', t => {
    const raiz = fixture(t);
    fs.appendFileSync(path.join(raiz, 'public/manifesto_sha256.json'), ' ');
    assert.throws(() => validarExportacao(raiz), /hash do manifesto/);
    selar(raiz);
    fs.appendFileSync(path.join(raiz, 'data/candidatos.json'), ' ');
    assert.throws(() => validarExportacao(raiz), /hash divergente/);
    selar(raiz);
    const asset = Object.keys(ler(raiz, 'public/manifesto_sha256.json')).find(n => n.startsWith('assets/'));
    fs.appendFileSync(path.join(raiz, 'public', asset), 'corrompido');
    assert.throws(() => validarExportacao(raiz), /hash divergente/);
});

test('não aceita propostas.json como substituto nem arquivo obrigatório ausente', t => {
    for (const nome of ARQUIVOS_DADOS) {
        const raiz = fixture(t);
        fs.renameSync(path.join(raiz, 'data', nome), path.join(raiz, 'data', 'propostas.json'));
        selar(raiz);
        assert.throws(() => validarExportacao(raiz), /ausente no manifesto/);
    }
});

test('rejeita traversal, caminhos Windows, desconhecidos e links', t => {
    const raiz = fixture(t);
    for (const nome of ['../fora.json', 'data/../candidatos.json', 'C:/segredo', 'assets\\foto\\x.jpg', 'public/dados_candidatos.json', 'data/propostas.json']) {
        selar(raiz, 'run-1', 'VALIDADA_TECNICAMENTE', { [nome]: 'a'.repeat(64) });
        assert.throws(() => validarExportacao(raiz), /entrada proibida/);
    }
    selar(raiz);
    fs.renameSync(path.join(raiz, 'data'), path.join(raiz, 'originais'));
    fs.symlinkSync(path.join(raiz, 'originais'), path.join(raiz, 'data'), 'junction');
    assert.throws(() => validarExportacao(raiz), /link proibido/);
});

for (const [nome, mutar, erro] of [
    ['candidatos', x => { x[chave].id = '999'; }, /identidade/],
    ['fotos', x => { delete x[chave]; }, /cobertura/],
    ['aliases_legados', x => { x.MG_123 = '2026_6259_MG_999'; }, /alias/],
    ['lista_busca', x => { x[0].partido = 'OUTRO'; }, /lista_busca/],
    ['textos_propostas', x => { x[chave][0].paginas[0].pagina = 2; }, /página/],
    ['textos_propostas', x => { x[chave][0].sha256Fonte = 'hash-inválido'; }, /PDF/],
    ['documentos', x => { x[chave].propostas[0].caminho = 'assets/proposta/2026_6259_MG_999/x.pdf'; }, /vínculo/],
    ['metadados', x => { x.totalCandidatos = 2; }, /metadados/],
    ['financeiro', x => { x[chave].receitas = {}; }, /financeiro/],
]) {
    test(`rejeita inconsistência selada: ${nome} ${erro}`, t => {
        const raiz = fixture(t);
        alterar(raiz, nome, mutar);
        assert.throws(() => validarExportacao(raiz), erro);
    });
}

test('importação idempotente, versões preservadas e colisão não altera ponteiro', t => {
    const destino = fixture(t, 'original');
    const origem = fixture(t, 'run-1');
    const primeiro = importarExportacao(origem, destino);
    assert.equal(carregarSnapshot(destino).runId, 'run-1');
    assert.deepEqual(importarExportacao(origem, destino), primeiro);
    assert.ok(fs.existsSync(path.join(destino, 'snapshots', primeiro.versao, 'public/EXPORTACAO_VALIDADA.json')));
    alterar(origem, 'textos_propostas', x => { x[chave][0].texto = 'Novo'; });
    const ponteiro = fs.readFileSync(path.join(destino, 'snapshots/ativo.json'));
    assert.throws(() => importarExportacao(origem, destino), /runId já associado/);
    assert.deepEqual(fs.readFileSync(path.join(destino, 'snapshots/ativo.json')), ponteiro);
    selar(origem, 'run-2');
    const segundo = importarExportacao(origem, destino);
    assert.notEqual(segundo.versao, primeiro.versao);
    assert.equal(carregarSnapshot(destino).runId, 'run-2');
    assert.ok(fs.existsSync(path.join(destino, 'snapshots', primeiro.versao)));
    fs.appendFileSync(path.join(origem, 'data/candidatos.json'), 'x');
    assert.throws(() => importarExportacao(origem, destino));
    assert.equal(carregarSnapshot(destino).runId, 'run-2');
});

test('ponteiro inválido falha fechado, sem fallback ao pacote atual', t => {
    const raiz = fixture(t);
    gravar(raiz, 'snapshots/ativo.json', { versao: '../data', runId: 'run-1' });
    assert.throws(() => carregarSnapshot(raiz), /ponteiro inválido/);
});

test('build não publica legado/controles/auditoria e gera busca da mesma versão', t => {
    const raiz = fixture(t, 'original');
    const origem = fixture(t, 'run-1');
    alterar(origem, 'textos_propostas', x => { x[chave][0].texto = 'Versão nova'; });
    const s = importarExportacao(origem, raiz);
    const resultado = build(raiz);
    assert.equal(resultado.versao, s.versao);
    assert.ok(fs.existsSync(path.join(raiz, 'dist/frontend-helpers.mjs')));
    assert.ok(fs.existsSync(path.join(raiz, 'dist/fonts/Open_Sans/OpenSans-VariableFont_wdth,wght.ttf')));
    const publicado = indicePublicado(raiz);
    assert.equal(publicado.exportacao, s.versao);
    assert.deepEqual(publicado.lista[0], { chave, nome: 'TESTE', nomeBusca: 'teste', uf: 'MG', cargo: 'GOVERNADOR', numeroUrna: '10' });
    assert.equal(ler(raiz, 'dist/exportacao.json').runId, 'run-1');
    for (const nome of ['dados_candidatos.json', 'auditoria', 'data', 'verificacao_dados.json', 'manifesto_sha256.json', 'EXPORTACAO_VALIDADA.json']) {
        assert.equal(fs.existsSync(path.join(raiz, 'dist', nome)), false, nome);
    }
    const segundo = build(raiz);
    assert.ok(fs.existsSync(path.join(segundo.anterior, 'index.html')));
    fs.appendFileSync(path.join(raiz, 'snapshots', s.versao, 'data/candidatos.json'), ' ');
    assert.throws(() => build(raiz), /hash divergente/);
    assert.equal(ler(raiz, 'dist/exportacao.json').versao, s.versao);
});

test('cache fixa bytes no processo mesmo após ativação e limparCache', t => {
    const raiz = fixture(t, 'original');
    const origem = fixture(t, 'run-2');
    alterar(origem, 'textos_propostas', x => { x[chave][0].texto = 'Nova versão'; });
    selar(origem, 'run-2');
    const modulo = pathToFileURL(path.resolve('lib/exportacao.js')).href;
    const codigo = `
        import assert from 'node:assert/strict';
        import fs from 'node:fs';
        import * as cache from ${JSON.stringify(cacheURL)};
        import { importarExportacao } from ${JSON.stringify(modulo)};
        const antes = cache.verificarExportacao();
        assert.equal(antes.runId, 'original');
        assert.equal(cache.lerJSON('../package.json'), null);
        assert.equal(cache.lerJSON('propostas.json'), null);
        assert.equal(cache.lerJSONPublico('dados_candidatos.json'), null);
        assert.equal(cache.buscarPorChave({}, 'toString'), null);
        assert.equal(cache.ehChaveCanonica('2026_x_MG_a'), false);
        assert.equal(cache.resolverAliasLegado('MG_123'), ${JSON.stringify(chave)});
        assert.throws(() => { cache.lerJSON('candidatos.json')[${JSON.stringify(chave)}].id = '999'; });
        importarExportacao(${JSON.stringify(origem)}, process.cwd());
        fs.writeFileSync('data/candidatos.json', '{}');
        cache.limparCache();
        cache.limparCache('candidatos.json');
        assert.deepEqual(cache.verificarExportacao(), antes);
        assert.equal(cache.lerJSON('candidatos.json')[${JSON.stringify(chave)}].id, '123');
        assert.equal(cache.obterSnapshot().runId, 'original');
        assert.deepEqual(cache.lerJSONPublico('lista_busca.json'), cache.lerJSON('lista_busca.json'));
    `;
    const p = spawnSync(process.execPath, ['--input-type=module', '-e', codigo], { cwd: raiz, encoding: 'utf8', timeout: 30000 });
    assert.equal(p.status, 0, p.stderr || p.error?.message);
});

test('JSON malformado e asset órfão são rejeitados mesmo com hashes refeitos', t => {
    const raiz = fixture(t);
    gravar(raiz, 'data/financeiro.json', '{malformado');
    selar(raiz);
    assert.throws(() => validarExportacao(raiz), /JSON inválido/);
    const outro = fixture(t);
    const buffer = Buffer.from('órfão');
    gravar(outro, `public/assets/proposta/${chave}/${sha256(buffer)}.pdf`, buffer);
    selar(outro);
    assert.throws(() => validarExportacao(outro), /asset sem vínculo/);
});

test('lock de importação impede concorrência sem alterar versão ativa', t => {
    const raiz = fixture(t);
    const origem = fixture(t);
    gravar(raiz, 'snapshots/.importacao.lock', 'outro processo');
    assert.throws(() => importarExportacao(origem, raiz), { code: 'EEXIST' });
    assert.equal(fs.existsSync(path.join(raiz, 'snapshots/ativo.json')), false);
    assert.equal(carregarSnapshot(raiz).runId, 'run-1');
});

test('CLI sem argumento falha e não cria snapshot', t => {
    const raiz = fixture(t);
    const script = new URL('../scripts/importar-exportacao.mjs', import.meta.url);
    const p = spawnSync(process.execPath, [fileURLToPath(script)], { cwd: raiz, encoding: 'utf8', timeout: 10000 });
    assert.equal(p.status, 1, p.stderr);
    assert.match(p.stderr, /Uso: npm run importar-exportacao/);
    assert.equal(fs.existsSync(path.join(raiz, 'snapshots/ativo.json')), false);
});

function layoutNotebook(raiz) {
    for (const nome of ['assets', 'EXPORTACAO_VALIDADA.json', 'manifesto_sha256.json']) {
        fs.renameSync(path.join(raiz, 'public', nome), path.join(raiz, nome));
    }
}

test('CLI importa layout notebook sem alterar bytes e build usa snapshot normalizado', t => {
    const origem = fixture(t, 'notebook');
    const destino = fixture(t, 'atual');
    const anterior = validarExportacao(origem);
    layoutNotebook(origem);
    const script = fileURLToPath(new URL('../scripts/importar-exportacao.mjs', import.meta.url));
    const p = spawnSync(process.execPath, [script, origem], { cwd: destino, encoding: 'utf8', timeout: 30000 });
    assert.equal(p.status, 0, p.stderr);
    const resultado = JSON.parse(p.stdout);
    assert.equal(resultado.runId, 'notebook');
    assert.equal(resultado.versao, anterior.versao);
    const snapshot = carregarSnapshot(destino);
    for (const nome of ARQUIVOS_DADOS) {
        assert.deepEqual(snapshot.dadosBytes[nome], fs.readFileSync(path.join(origem, 'data', nome)));
    }
    assert.deepEqual(snapshot.manifestoBytes, fs.readFileSync(path.join(origem, 'manifesto_sha256.json')));
    assert.deepEqual(snapshot.marcadorBytes, fs.readFileSync(path.join(origem, 'EXPORTACAO_VALIDADA.json')));
    for (const [nome, hash] of Object.entries(snapshot.controles['manifesto_sha256.json'])) {
        if (nome.startsWith('assets/')) {
            assert.equal(sha256(fs.readFileSync(path.join(origem, nome))), hash);
            assert.equal(sha256(fs.readFileSync(path.join(snapshot.raiz, 'public', nome))), hash);
        }
    }
    assert.equal(fs.existsSync(path.join(snapshot.raiz, 'data/propostas.json')), false);
    assert.equal(build(destino).versao, anterior.versao);
    assert.equal(indicePublicado(destino).exportacao, anterior.versao);
    assert.equal(ler(destino, 'public/EXPORTACAO_VALIDADA.json').runId, 'atual');
});

test('importação não mistura layouts nem usa fallback após corrupção', t => {
    const origem = fixture(t);
    const destino = fixture(t, 'atual');
    gravar(origem, 'EXPORTACAO_VALIDADA.json', ler(origem, 'public/EXPORTACAO_VALIDADA.json'));
    assert.throws(() => importarExportacao(origem, destino), /layout ausente ou ambíguo/);
    fs.unlinkSync(path.join(origem, 'EXPORTACAO_VALIDADA.json'));
    layoutNotebook(origem);
    fs.renameSync(path.join(origem, 'manifesto_sha256.json'), path.join(origem, 'public/manifesto_sha256.json'));
    assert.throws(() => importarExportacao(origem, destino), /layout ausente ou ambíguo/);
    fs.renameSync(path.join(origem, 'public/manifesto_sha256.json'), path.join(origem, 'manifesto_sha256.json'));
    fs.appendFileSync(path.join(origem, 'manifesto_sha256.json'), ' ');
    assert.throws(() => importarExportacao(origem, destino), /hash do manifesto/);
    assert.equal(fs.existsSync(path.join(destino, 'snapshots/ativo.json')), false);
});

test('campos de proveniência e controles opcionais permanecem desconhecidos', t => {
    const raiz = fixture(t);
    alterar(raiz, 'textos_propostas', x => {
        const pdf = x[chave][0];
        delete pdf.sha256Fonte;
        delete pdf.geradoPorIA;
        delete pdf.aptoParaRascunho;
        delete pdf.statusExtracao;
        delete pdf.paginas[0].revisar;
        delete pdf.paginas[0].status;
        delete pdf.paginas[0].metodo;
    });
    let pdf = validarExportacao(raiz).dados['textos_propostas.json'][chave][0];
    assert.equal(Object.hasOwn(pdf, 'aptoParaRascunho'), false);
    assert.equal(Object.hasOwn(pdf.paginas[0], 'revisar'), false);
    alterar(raiz, 'textos_propostas', x => {
        x[chave][0].sha256Fonte = 'a'.repeat(64);
        x[chave][0].geradoPorIA = true;
        x[chave][0].aptoParaRascunho = null;
        x[chave][0].paginas[0].revisar = null;
    });
    pdf = validarExportacao(raiz).dados['textos_propostas.json'][chave][0];
    assert.equal(pdf.sha256Fonte, 'a'.repeat(64));
    assert.equal(pdf.aptoParaRascunho, null);
    assert.equal(pdf.paginas[0].revisar, null);
    alterar(raiz, 'textos_propostas', x => { x[chave][0].sha256 = 'a'.repeat(64); });
    assert.throws(() => validarExportacao(raiz), /vínculo\/hash/);
});

test('extração pendente/falha permite páginas parciais e campos desconhecidos', t => {
    const raiz = fixture(t);
    const casos = [
        { totalPaginas: 3, paginas: [{ pagina: 1, texto: null }], texto: null, statusExtracao: 'pendente' },
        { totalPaginas: null, paginas: [], texto: null, statusExtracao: 'falha' },
        { totalPaginas: null, paginas: null, texto: null },
        { totalPaginas: 3, paginas: [] },
        { totalPaginas: 3, paginas: [{ pagina: 3 }, { pagina: 1, texto: '' }], aptoParaRascunho: true },
        { totalPaginas: null, paginas: [{ pagina: 8, texto: null }] },
        {},
    ];
    for (const campos of casos) {
        alterar(raiz, 'textos_propostas', x => {
            const { nome, arquivo, sha256 } = x[chave][0];
            x[chave][0] = { nome, arquivo, sha256, ...campos };
        });
        selar(raiz, 'run-1', 'VALIDADO_COM_AVISOS');
        const s = validarExportacao(raiz);
        assert.equal(s.ok, true);
        assert.equal(s.status, 'VALIDADO_COM_AVISOS');
        const pdf = s.dados['textos_propostas.json'][chave][0];
        for (const campo of ['texto', 'totalPaginas', 'paginas', 'aptoParaRascunho']) {
            assert.deepEqual(pdf[campo], campos[campo]);
            assert.equal(Object.hasOwn(pdf, campo), Object.hasOwn(campos, campo));
        }
        build(raiz);
        assert.deepEqual(carregarFonteSnapshot(raiz).dados['textos_propostas.json'][chave][0], pdf);
    }
});

test('páginas parciais rejeitam duplicidade, números inválidos e fora do total', t => {
    const raiz = fixture(t);
    for (const [totalPaginas, paginas] of [
        [3, [{ pagina: 1 }, { pagina: 1 }]],
        [null, [{ pagina: 2 }, { pagina: 2 }]],
        [3, [{ pagina: 4 }]],
        [null, [{ pagina: 0 }]],
        [null, [{ pagina: -1 }]],
        [null, [{ pagina: 1.5 }]],
        [null, [{ pagina: '1' }]],
        [null, [{ pagina: Number.MAX_SAFE_INTEGER + 1 }]],
        [null, [{}]],
        [null, [null]],
    ]) {
        alterar(raiz, 'textos_propostas', x => {
            Object.assign(x[chave][0], { totalPaginas, paginas, texto: null, statusExtracao: 'pendente' });
        });
        assert.throws(() => validarExportacao(raiz), /página inválida/);
    }
});

test('extração pendente não permite tipos inválidos nem dispensa hash e vínculo do PDF', t => {
    const raiz = fixture(t);
    alterar(raiz, 'textos_propostas', x => {
        const { nome, arquivo, sha256 } = x[chave][0];
        x[chave][0] = { nome, arquivo, sha256, texto: null, totalPaginas: null, paginas: null };
    });
    const original = ler(raiz, 'data/textos_propostas.json')[chave][0];
    for (const campos of [
        { totalPaginas: 0 }, { totalPaginas: -1 }, { totalPaginas: '3' }, { totalPaginas: 1.5 },
        { paginas: {} }, { texto: 42 }, { paginas: [{ pagina: 1, texto: {} }] },
    ]) {
        alterar(raiz, 'textos_propostas', x => { x[chave][0] = { ...original, ...campos }; });
        assert.throws(() => validarExportacao(raiz), /PDF\/páginas|página inválida/);
    }
    alterar(raiz, 'textos_propostas', x => { x[chave][0] = { ...original, sha256: 'a'.repeat(64) }; });
    assert.throws(() => validarExportacao(raiz), /vínculo\/hash/);
    alterar(raiz, 'textos_propostas', x => { x[chave] = []; });
    assert.throws(() => validarExportacao(raiz), /cobertura dos PDFs/);
    alterar(raiz, 'textos_propostas', x => { x[chave] = [original]; });
    fs.unlinkSync(path.join(raiz, 'public', original.arquivo));
    assert.throws(() => validarExportacao(raiz), /ENOENT/);
});

test('metadados/auditoria sem campos auxiliares e escopo ano string são aceitos', t => {
    const raiz = fixture(t);
    gravar(raiz, 'data/metadados.json', { status: 'VALIDADO_COM_AVISOS', escopo: { ano: '2026', ufs: ['MG'] } });
    gravar(raiz, 'data/verificacao_dados.json', { status: 'VALIDADO' });
    selar(raiz);
    assert.equal(validarExportacao(raiz).ok, true);
    alterar(raiz, 'metadados', x => { x.escopo.ano = '2027'; });
    assert.throws(() => validarExportacao(raiz), /fora do escopo/);
});

test('foto null aceita outros estados e foto sem sha256 confere bytes pelo manifesto', t => {
    const raiz = fixture(t);
    for (const status of ['ausente', 'nao_disponivel', 'pendente']) {
        alterar(raiz, 'fotos', x => { x[chave].status = status; });
        assert.equal(validarExportacao(raiz).ok, true);
    }
    const buffer = Buffer.from('foto fixture');
    const arquivo = `assets/foto/${chave}/${sha256(buffer)}.jpg`;
    gravar(raiz, `public/${arquivo}`, buffer);
    alterar(raiz, 'fotos', x => { x[chave] = { arquivo, status: 'ok' }; });
    alterar(raiz, 'lista_busca', x => { x[0].foto = arquivo; });
    alterar(raiz, 'metadados', x => { x.totalFotos = 1; });
    assert.equal(validarExportacao(raiz).ok, true);
    alterar(raiz, 'fotos', x => { x[chave].sha256 = 'a'.repeat(64); });
    assert.throws(() => validarExportacao(raiz), /vínculo\/hash/);
    alterar(raiz, 'fotos', x => { delete x[chave].sha256; });
    fs.appendFileSync(path.join(raiz, 'public', arquivo), 'corrompida');
    assert.throws(() => validarExportacao(raiz), /hash divergente/);
});

test('aliases ambíguos podem ser omitidos, mas nunca escolher uma candidatura', t => {
    const raiz = fixture(t);
    const segunda = '2026_9999_MG_123';
    const c = { ...ler(raiz, 'data/candidatos.json')[chave], chave: segunda, codigoEleicao: '9999' };
    alterar(raiz, 'candidatos', x => { x[segunda] = c; });
    for (const nome of ['financeiro', 'fotos', 'juridico', 'patrimonio']) {
        alterar(raiz, nome, x => { x[segunda] = structuredClone(x[chave]); });
    }
    alterar(raiz, 'documentos', x => { x[segunda] = { propostas: [], certidoes: [] }; });
    alterar(raiz, 'textos_propostas', x => { x[segunda] = []; });
    alterar(raiz, 'lista_busca', x => { x.push({ ...x[0], ...c }); });
    alterar(raiz, 'metadados', x => { x.totalCandidatos = 2; });
    alterar(raiz, 'aliases_legados', x => { delete x.MG_123; });
    assert.equal(validarExportacao(raiz).ok, true);
    const codigo = `import assert from 'node:assert/strict'; import {resolverAliasLegado} from ${JSON.stringify(cacheURL)}; assert.equal(resolverAliasLegado('MG_123'), null);`;
    const p = spawnSync(process.execPath, ['--input-type=module', '-e', codigo], { cwd: raiz, encoding: 'utf8', timeout: 10000 });
    assert.equal(p.status, 0, p.stderr);
    alterar(raiz, 'aliases_legados', x => { x.MG_123 = chave; });
    assert.throws(() => validarExportacao(raiz), /alias inconsistente/);
});

const GRUPOS_MONETARIOS = [
    ['patrimonio', 'bens', 'quantidade', 'totalCentavos', 'status', 'zerosExplicitos'],
    ['financeiro', 'receitas', 'quantidade_receitas', 'total_arrecadado_centavos', 'status_receitas', 'receitas_zeros_explicitos'],
    ['financeiro', 'despesasContratadas', 'quantidade_despesas_contratadas', 'total_contratado_centavos', 'status_contratadas', 'contratadas_zeros_explicitos'],
    ['financeiro', 'pagamentos', 'quantidade_despesas_pagas', 'total_pago_centavos', 'status_pagamento', 'pagas_zeros_explicitos'],
];
for (const [nome, lista, quantidade, total, status, zeros] of GRUPOS_MONETARIOS) {
    test(`totais e contagens exatos sem deduplicar: ${nome}.${lista}`, t => {
        const raiz = fixture(t);
        const valor = '9007199254740993';
        const soma = (BigInt(valor) * 2n - 1n).toString();
        alterar(raiz, nome, x => {
            Object.assign(x[chave], { [status]: 'ok', [quantidade]: 4, [total]: soma, [zeros]: 1,
                [lista]: [{ valorCentavos: valor }, { valorCentavos: valor }, { valorCentavos: '-1' }, { valorCentavos: '0' }] });
        });
        const s = validarExportacao(raiz);
        assert.equal(s.dados[`${nome}.json`][chave][lista].length, 4);
        assert.equal(s.dados[`${nome}.json`][chave][total], soma);
        alterar(raiz, nome, x => { x[chave][total] = (BigInt(soma) + 1n).toString(); });
        assert.throws(() => validarExportacao(raiz), /total exato divergente/);
        alterar(raiz, nome, x => { x[chave][total] = soma; x[chave][quantidade] = 3; });
        assert.throws(() => validarExportacao(raiz), /contagem divergente|patrimônio inválido/);
        alterar(raiz, nome, x => { x[chave][quantidade] = 4; x[chave][zeros] = 0; });
        assert.throws(() => validarExportacao(raiz), /contagem divergente/);
        alterar(raiz, nome, x => { x[chave][zeros] = 1; x[chave][lista][0].valorCentavos = null; });
        assert.throws(() => validarExportacao(raiz), /centavos ausentes com status ok/);
        alterar(raiz, nome, x => { x[chave][status] = 'parcial'; x[chave][total] = null; });
        assert.equal(validarExportacao(raiz).ok, true);
    });
}

test('centavos rejeitam Number, decimais, expoentes e objetos mesmo sem status ok', t => {
    const raiz = fixture(t);
    for (const valor of [1, 1.5, '1.5', '1e3', '', ' 10 ', {}, []]) {
        alterar(raiz, 'financeiro', x => { x[chave].limite_gastos_centavos = valor; });
        assert.throws(() => validarExportacao(raiz), /centavos inválidos/);
    }
    alterar(raiz, 'financeiro', x => { x[chave].limite_gastos_centavos = null; });
    assert.equal(validarExportacao(raiz).ok, true);
    alterar(raiz, 'financeiro', x => { x[chave].doadoresOriginarios = [{ valorCentavos: 12 }]; });
    assert.throws(() => validarExportacao(raiz), /centavos inválidos/);
});

test('doadores originários preservam repetições sem entrar na soma de receitas', t => {
    const raiz = fixture(t);
    alterar(raiz, 'financeiro', x => {
        Object.assign(x[chave], { status_receitas: 'ok', quantidade_receitas: 1, total_arrecadado_centavos: '100',
            receitas: [{ valorCentavos: '100' }], statusOriginarios: 'ok',
            doadoresOriginarios: [{ valorCentavos: '100' }, { valorCentavos: '100' }, { valorCentavos: null }] });
    });
    const f = validarExportacao(raiz).dados['financeiro.json'][chave];
    assert.equal(f.total_arrecadado_centavos, '100');
    assert.equal(f.doadoresOriginarios.length, 3);
});

test('identificadores longos permanecem strings exatas', t => {
    const raiz = fixture(t);
    const id = '900719925474099312345';
    const nova = `2026_6259_MG_${id}`;
    for (const nome of ['candidatos', 'financeiro', 'fotos', 'juridico', 'patrimonio']) {
        alterar(raiz, nome, x => { x[nova] = x[chave]; delete x[chave]; });
    }
    alterar(raiz, 'candidatos', x => { x[nova].id = id; x[nova].chave = nova; });
    gravar(raiz, 'data/documentos.json', { [nova]: { propostas: [], certidoes: [] } });
    gravar(raiz, 'data/textos_propostas.json', { [nova]: [] });
    gravar(raiz, 'data/aliases_legados.json', { [`MG_${id}`]: nova });
    fs.rmSync(path.join(raiz, 'public/assets/proposta'), { recursive: true });
    alterar(raiz, 'lista_busca', x => { x[0].id = id; x[0].chave = nova; });
    const s = validarExportacao(raiz);
    assert.equal(s.dados['candidatos.json'][nova].id, id);
});

test('runtime privado contém só JSONs, controles e recibo; carrega sem PDFs', t => {
    const raiz = fixture(t);
    const original = validarExportacao(raiz);
    const resultado = build(raiz);
    assert.equal(resultado.versao, original.versao);
    assert.deepEqual(fs.readdirSync(path.join(raiz, 'runtime')).sort(), ['data', 'public', 'recibo_build.json']);
    assert.deepEqual(fs.readdirSync(path.join(raiz, 'runtime/data')).sort(), [...ARQUIVOS_DADOS].sort());
    assert.deepEqual(fs.readdirSync(path.join(raiz, 'runtime/public')).sort(), ['EXPORTACAO_VALIDADA.json', 'manifesto_sha256.json']);
    assert.equal(fs.existsSync(path.join(raiz, 'dist/runtime')), false);
    assert.equal(fs.existsSync(path.join(raiz, 'dist/recibo_build.json')), false);
    assert.equal(fs.existsSync(path.join(raiz, 'dist/verificacao_dados.json')), false);
    assert.equal(fs.existsSync(path.join(raiz, 'runtime/public/assets')), false);
    fs.rmSync(path.join(raiz, 'data'), { recursive: true });
    fs.rmSync(path.join(raiz, 'public'), { recursive: true });
    const runtime = carregarFonteSnapshot(raiz);
    assert.equal(runtime.runtime, true);
    assert.equal(runtime.raiz, path.join(raiz, 'runtime'));
    assert.equal(runtime.versao, original.versao);
    for (const nome of ARQUIVOS_DADOS) assert.deepEqual(runtime.dadosBytes[nome], original.dadosBytes[nome]);
    assert.equal(ler(raiz, 'dist/exportacao.json').versao, runtime.versao);
    assert.equal(indicePublicado(raiz).exportacao, runtime.versao);
});

test('cada um dos 11 JSONs é conferido no runtime sem fallback', t => {
    const raiz = fixture(t);
    build(raiz);
    for (const nome of ARQUIVOS_DADOS) {
        const arquivo = path.join(raiz, 'runtime/data', nome);
        const original = fs.readFileSync(arquivo);
        fs.appendFileSync(arquivo, ' ');
        assert.throws(() => carregarFonteSnapshot(raiz), /hash divergente/, nome);
        fs.writeFileSync(arquivo, original);
        fs.unlinkSync(arquivo);
        assert.throws(() => carregarFonteSnapshot(raiz), /ENOENT/, nome);
        fs.writeFileSync(arquivo, original);
    }
});

test('runtime rejeita manifesto, marcador e recibo adulterados ou ausentes', t => {
    const raiz = fixture(t);
    build(raiz);
    for (const nome of ['public/manifesto_sha256.json', 'public/EXPORTACAO_VALIDADA.json', 'recibo_build.json']) {
        const arquivo = path.join(raiz, 'runtime', nome);
        const original = fs.readFileSync(arquivo);
        fs.appendFileSync(arquivo, ' ');
        assert.throws(() => carregarFonteSnapshot(raiz), /manifesto|recibo/, nome);
        fs.writeFileSync(arquivo, original);
        fs.unlinkSync(arquivo);
        assert.throws(() => carregarFonteSnapshot(raiz), /ENOENT/, nome);
        fs.writeFileSync(arquivo, original);
    }
    const recibo = ler(raiz, 'runtime/recibo_build.json');
    for (const [campo, valor] of [
        ['tipo', 'EXPORTACAO_VALIDADA'], ['schemaVersion', 2], ['runId', 'outro'],
        ['versao', 'a'.repeat(64)], ['manifestoSHA256', 'a'.repeat(64)],
        ['marcadorSHA256', 'a'.repeat(64)], ['inventarioAssetsSHA256', 'a'.repeat(64)],
        ['quantidadeAssets', 99], ['dadosSHA256', {}],
    ]) {
        gravar(raiz, 'runtime/recibo_build.json', JSON.stringify({ ...recibo, [campo]: valor }) + '\n');
        assert.throws(() => carregarFonteSnapshot(raiz), /recibo/);
    }
    gravar(raiz, 'runtime/recibo_build.json', ler(raiz, 'public/EXPORTACAO_VALIDADA.json'));
    assert.throws(() => carregarFonteSnapshot(raiz), /recibo/);
});

test('runtime ainda valida schema, identidades e vínculos com manifesto refeito', t => {
    for (const [nome, mutar, erro] of [
        ['candidatos.json', x => { x[chave].id = '999'; }, /identidade/],
        ['documentos.json', x => { x[chave].propostas[0].sha256 = 'a'.repeat(64); }, /vínculo/],
        ['textos_propostas.json', x => { x[chave][0].paginas[0].pagina = 9; }, /página/],
        ['financeiro.json', x => { x[chave].limite_gastos_centavos = 1.5; }, /centavos/],
    ]) {
        const raiz = fixture(t);
        build(raiz);
        const dados = ler(raiz, `runtime/data/${nome}`);
        mutar(dados);
        gravar(raiz, `runtime/data/${nome}`, dados);
        const manifesto = ler(raiz, 'runtime/public/manifesto_sha256.json');
        manifesto[`data/${nome}`] = sha256(fs.readFileSync(path.join(raiz, 'runtime/data', nome)));
        gravar(raiz, 'runtime/public/manifesto_sha256.json', manifesto);
        const marcador = ler(raiz, 'runtime/public/EXPORTACAO_VALIDADA.json');
        marcador.manifestoSHA256 = sha256(fs.readFileSync(path.join(raiz, 'runtime/public/manifesto_sha256.json')));
        gravar(raiz, 'runtime/public/EXPORTACAO_VALIDADA.json', marcador);
        assert.throws(() => carregarFonteSnapshot(raiz), erro);
    }
});

test('build e importação nunca usam recibo como substituto da validação dos assets', t => {
    const raiz = fixture(t);
    const destino = fixture(t, 'destino');
    build(raiz);
    const reciboAntes = fs.readFileSync(path.join(raiz, 'runtime/recibo_build.json'));
    const asset = Object.keys(ler(raiz, 'public/manifesto_sha256.json')).find(n => n.startsWith('assets/'));
    fs.appendFileSync(path.join(raiz, 'public', asset), 'adulterado');
    assert.equal(carregarFonteSnapshot(raiz).runtime, true);
    assert.throws(() => build(raiz), /hash divergente/);
    assert.throws(() => importarExportacao(raiz, destino), /hash divergente/);
    assert.deepEqual(fs.readFileSync(path.join(raiz, 'runtime/recibo_build.json')), reciboAntes);
    assert.equal(fs.existsSync(path.join(destino, 'snapshots/ativo.json')), false);
    assert.throws(() => gerarRuntime(carregarRuntime(path.join(raiz, 'runtime')), path.join(raiz, 'falso'), []), /snapshot integral/);
});

test('runtime incompleto ou publicação em andamento falha fechado; local valida integralmente', t => {
    const raiz = fixture(t);
    assert.equal(carregarFonteSnapshot(raiz).runtime, false);
    gravar(raiz, '.build-publicacao.lock', 'publicando');
    assert.throws(() => carregarFonteSnapshot(raiz), /Publicação/);
    fs.unlinkSync(path.join(raiz, '.build-publicacao.lock'));
    fs.mkdirSync(path.join(raiz, 'runtime'));
    assert.throws(() => carregarFonteSnapshot(raiz), /ENOENT/);
    fs.rmdirSync(path.join(raiz, 'runtime'));
    const asset = Object.keys(ler(raiz, 'public/manifesto_sha256.json')).find(n => n.startsWith('assets/'));
    fs.unlinkSync(path.join(raiz, 'public', asset));
    assert.throws(() => carregarFonteSnapshot(raiz), /ENOENT/);
});

test('falha na ativação do runtime restaura o par dist/runtime anterior', t => {
    const raiz = fixture(t);
    build(raiz);
    const distAntes = fs.readFileSync(path.join(raiz, 'dist/exportacao.json'));
    const reciboAntes = fs.readFileSync(path.join(raiz, 'runtime/recibo_build.json'));
    alterar(raiz, 'textos_propostas', x => { x[chave][0].texto = 'Nova versão'; });
    const rename = fs.renameSync;
    fs.renameSync = (origem, destino) => {
        if (path.basename(origem).startsWith('.build-runtime-') && destino === path.join(raiz, 'runtime')) throw new Error('Falha simulada de rename');
        return rename(origem, destino);
    };
    try { assert.throws(() => build(raiz), /Falha simulada/); }
    finally { fs.renameSync = rename; }
    assert.deepEqual(fs.readFileSync(path.join(raiz, 'dist/exportacao.json')), distAntes);
    assert.deepEqual(fs.readFileSync(path.join(raiz, 'runtime/recibo_build.json')), reciboAntes);
    assert.equal(fs.existsSync(path.join(raiz, '.build-publicacao.lock')), false);
    assert.equal(fs.existsSync(path.join(raiz, '.build.lock')), false);
});

test('fonte interna fixa runtime e oferece cópias dos bytes após novo build', t => {
    const raiz = fixture(t, 'original');
    const origem = fixture(t, 'novo');
    alterar(origem, 'textos_propostas', x => { x[chave][0].texto = 'Nova versão'; });
    selar(origem, 'novo');
    build(raiz);
    const exportacaoURL = new URL('../lib/exportacao.js', import.meta.url).href;
    const buildURL = new URL('../scripts/build.mjs', import.meta.url).href;
    const codigo = `
        import assert from 'node:assert/strict';
        import * as cache from ${JSON.stringify(cacheURL)};
        import { importarExportacao } from ${JSON.stringify(exportacaoURL)};
        import { build } from ${JSON.stringify(buildURL)};
        const fonte = cache.obterFonteSnapshot();
        assert.equal(fonte.runtime, true);
        assert.equal(fonte.raiz, ${JSON.stringify(path.join(raiz, 'runtime'))});
        const bytes = fonte.lerBytes('textos_propostas.json');
        fonte.lerBytes('textos_propostas.json').fill(0);
        assert.deepEqual(fonte.lerBytes('textos_propostas.json'), bytes);
        assert.equal(fonte.lerBytes('../package.json'), null);
        assert.throws(() => { fonte.dados['textos_propostas.json'][${JSON.stringify(chave)}][0].texto = 'mutação'; });
        importarExportacao(${JSON.stringify(origem)}, process.cwd());
        build();
        cache.limparCache();
        assert.equal(cache.obterFonteSnapshot().runId, 'original');
        assert.deepEqual(cache.obterFonteSnapshot().lerBytes('textos_propostas.json'), bytes);
        assert.equal(cache.obterSnapshot().versao, fonte.versao);
    `;
    const p = spawnSync(process.execPath, ['--input-type=module', '-e', codigo], { cwd: raiz, encoding: 'utf8', timeout: 30000 });
    assert.equal(p.status, 0, p.stderr);
    assert.equal(carregarFonteSnapshot(raiz).runId, 'novo');
    assert.deepEqual(fs.readdirSync(path.join(raiz, 'runtime')).sort(), ['data', 'public', 'recibo_build.json']);
});

test('recibo só é gerado se os assets e busca escritos conferirem', t => {
    const raiz = fixture(t);
    build(raiz);
    const reciboAntes = fs.readFileSync(path.join(raiz, 'runtime/recibo_build.json'));
    const snapshot = validarExportacao(raiz);
    assert.throws(() => gerarRuntime(snapshot, path.join(raiz, 'falso'), []), /Inventário copiado/);
    for (const alvo of ['.pdf', 'busca']) {
        const escrever = fs.writeFileSync;
        fs.writeFileSync = (arquivo, buffer, ...opcoes) => {
            const nome = String(arquivo);
            if (nome.includes('.build-') && (alvo === 'busca' ? nome.includes('busca') : nome.endsWith(alvo))) buffer = Buffer.from('cópia corrompida');
            return escrever(arquivo, buffer, ...opcoes);
        };
        try { assert.throws(() => build(raiz), /asset copiado diverge|Busca\/identidade pública diverge/); }
        finally { fs.writeFileSync = escrever; }
        assert.deepEqual(fs.readFileSync(path.join(raiz, 'runtime/recibo_build.json')), reciboAntes);
    }
});

test('Vercel inclui somente runtime e resumos publicados e exclui fontes volumosas', () => {
    const config = JSON.parse(fs.readFileSync(new URL('../vercel.json', import.meta.url)));
    const funcao = config.functions['api/**/*.js'];
    assert.equal(funcao.includeFiles, '{runtime/**,data/resumos_publicados/**}');
    for (const padrao of ['snapshots/**', 'public/**', 'dist/**', '.build-*/**', 'data/*.json']) {
        assert.ok(funcao.excludeFiles.includes(padrao));
    }
});
