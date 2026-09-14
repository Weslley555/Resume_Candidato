import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import * as helpers from '../public/frontend-helpers.mjs';
const { fmtCentavos, inteiroExato, compararBens, valorFinanceiro, assetURL, publicBase,
    filtrarLista, identificadorAPI, selecaoDocumentos, criarControleRequisicao } = helpers;
const hash = 'a'.repeat(64), outroHash = 'b'.repeat(64);
const chave = '2026_6257_BR_280002538811', outraChave = '2026_6259_MG_130002539775';

test('centavos exatos, negativos, zero, ausentes e entradas inválidas', () => {
    assert.equal(fmtCentavos('900719925474099312345'), 'R$\u00a09.007.199.254.740.993.123,45');
    assert.equal(fmtCentavos('-1'), '-R$\u00a00,01');
    assert.equal(fmtCentavos('0'), 'R$\u00a00,00');
    for (const value of [null, undefined, '', ' ', true, false, '1.2', '0x10', Number.MAX_SAFE_INTEGER + 1]) {
        assert.equal(inteiroExato(value), null);
        assert.equal(fmtCentavos(value), null);
    }
    assert.equal(compararBens({ valorCentavos: '9007199254740993001' }, { valorCentavos: '9007199254740993000' }), -1);
    assert.equal(compararBens({ valorCentavos: null }, { valorCentavos: '0' }), 1);
    assert.equal(valorFinanceiro('0', 'ok'), 'R$\u00a00,00');
    assert.equal(valorFinanceiro('0', 'sem_fonte'), 'Fonte não disponível');
    assert.equal(valorFinanceiro(null, 'ok'), 'Valor não informado');
    assert.match(valorFinanceiro('0', undefined), /Estado não informado/);
});

test('assets locais restritos por categoria, chave e hash completo', () => {
    const caminho = `assets/proposta/${chave}/${hash}.pdf`;
    assert.equal(assetURL(caminho, { base: '/portal/', tipo: 'proposta', chave, sha256: hash }), `/portal/${caminho}`);
    assert.equal(assetURL('/' + caminho), '/' + caminho);
    assert.equal(assetURL(caminho, { chave: outraChave }), null);
    assert.equal(assetURL(caminho, { sha256: outroHash }), null);
    assert.equal(assetURL(caminho, { tipo: 'certidao' }), null);
    for (const bad of ['https://evil.test/' + caminho, '//evil.test/' + caminho, '../' + caminho, caminho + '?x=1', caminho + '#page=1', caminho.replace(hash, 'a'.repeat(8)), caminho.replace('assets/', 'assets/../'), caminho.replace('.pdf', '.svg'), caminho.replace('proposta', 'foto'), caminho.replace(chave, '%2e%2e'), caminho.replaceAll('/', '\\')]) {
        assert.equal(assetURL(bad), null, bad);
    }
    assert.equal(publicBase('https://evil.test/'), '/');
    assert.equal(publicBase('//evil.test/'), '/');
    assert.equal(publicBase('/portal'), '/portal/');
});

test('BR é circunscrição, busca não resolve identidade e legado só é enviado à API', () => {
    const lista = [{ chave, uf: 'BR', nome: 'João', numeroUrna: '10' }, { chave: outraChave, uf: 'MG', nome: 'João', numeroUrna: '101' }];
    assert.equal(filtrarLista(lista, 'joao', 'BR', '').length, 1);
    assert.equal(filtrarLista(lista, '10', '', '').length, 2);
    assert.equal(identificadorAPI('BR_280002538811'), true);
    for (const value of ['João', '10', '280002538811', 'BR_abc']) assert.equal(identificadorAPI(value), false);
});

test('seleção não escolhe primeiro PDF e só aceita hashes apresentados', () => {
    const docs = [{ sha256: hash }, { sha256: outroHash }];
    assert.deepEqual(selecaoDocumentos(docs, []), []);
    assert.deepEqual(selecaoDocumentos(docs, [outroHash, outroHash, 'c'.repeat(64)]), [outroHash]);
});

test('descritor versionado e cache limitado impedem mistura, duplicação e crescimento ilimitado', async () => {
    assert.deepEqual(helpers.descritorIndice({ versao: hash, indice: { sha256: outroHash, arquivo: `busca/${hash}.${outroHash}.json` } }),
        { arquivo: `busca/${hash}.${outroHash}.json`, versao: hash });
    for (const invalido of [null, { versao: hash, indice: { sha256: outroHash, arquivo: 'lista_busca.json' } },
        { versao: outroHash, indice: { sha256: outroHash, arquivo: `busca/${hash}.${outroHash}.json` } }]) {
        assert.equal(helpers.descritorIndice(invalido), null);
    }
    const cache = helpers.criarCacheLimitado(2);
    let chamadas = 0;
    const a = cache.obter(`${hash}:a`, async () => { chamadas++; return 'A'; });
    const concorrente = cache.obter(`${hash}:a`, async () => { chamadas++; return 'OUTRO'; });
    assert.strictEqual(a, concorrente);
    assert.equal(await concorrente, 'A'); assert.equal(chamadas, 1);
    await cache.obter(`${hash}:b`, async () => 'B');
    await cache.obter(`${outroHash}:a`, async () => 'NOVA');
    assert.equal(cache.tamanho, 2);
    await cache.obter(`${hash}:a`, async () => { chamadas++; return 'RECARREGADA'; });
    assert.equal(chamadas, 2);
});

test('controle invalida respostas mesmo se abort não impedir sua chegada', () => {
    const controle = criarControleRequisicao();
    const antigo = controle.iniciar(), novo = controle.iniciar();
    assert.equal(antigo.signal.aborted, true);
    assert.equal(antigo.vigente(), false);
    assert.equal(novo.vigente(), true);
    controle.cancelar(); assert.equal(novo.vigente(), false);
});

// DOM mínimo para executar o script real sem dependências ou acesso às bases.
class Node {
    constructor(tag = 'div') {
        this.tag = tag; this.children = []; this.events = {}; this.style = {}; this.value = '';
        this.classes = new Set();
        this.classList = { add: c => this.classes.add(c), remove: c => this.classes.delete(c), contains: c => this.classes.has(c) };
    }
    set textContent(value) { this.ownText = String(value); this.children = []; }
    get textContent() { return (this.ownText ?? '') + this.children.map(c => c.textContent).join(''); }
    append(...nodes) { this.children.push(...nodes); }
    replaceChildren(...nodes) { this.ownText = ''; this.children = nodes; }
    addEventListener(event, fn) { this.events[event] = fn; }
    setAttribute(name, value) { this[name] = String(value); }
    querySelectorAll(selector) {
        const nodes = this.children.flatMap(c => [c, ...c.querySelectorAll('*')]);
        return selector === 'input:checked' ? nodes.filter(c => c.tag === 'input' && c.checked) : nodes;
    }
}
async function ambiente(id = null, { inicializar = true, base = '/', versaoAssets = hash, versaoAPI = hash } = {}) {
    const elements = new Map();
    const get = name => {
        if (!elements.has(name)) elements.set(name, new Node());
        return elements.get(name);
    };
    get('selecaoDocumentos').append(get('opcoesDocumentos'));
    const chamadas = [], requisicoes = [];
    const location = { href: 'https://site.test/' + (id ? '?id=' + id : '') };
    const context = vm.createContext({ ...helpers, URL, URLSearchParams, AbortController, console,
        location, history: { replaceState: (_, __, url) => { location.href = String(url); } },
        window: { addEventListener() {} },
        document: {
            getElementById: get, createElement: tag => new Node(tag), createTextNode: value => { const n = new Node('text'); n.textContent = value; return n; },
            querySelector: selector => selector.startsWith('meta') ? { content: base } : get(selector),
            querySelectorAll: () => [],
        },
        fetch: (url, options) => new Promise(resolve => {
            const chamada = { url, options, responder: (data, status = 200) => resolve({ ok: status >= 200 && status < 300, status, json: async () => data }) };
            requisicoes.push(chamada);
            if (url.startsWith('/api/')) chamadas.push(chamada);
        }),
    });
    const script = (await readFile(new URL('../public/script.js', import.meta.url), 'utf8')).replace(/^import\s*\{[\s\S]*?\}\s*from\s*'[^']+';\s*/, '');
    vm.runInContext(script, context);
    const tick = () => new Promise(resolve => setImmediate(resolve));
    if (inicializar) {
        const indiceHash = outroHash;
        requisicoes[0].responder({ versao: versaoAssets,
            indice: { arquivo: `busca/${versaoAssets}.${indiceHash}.json`, sha256: indiceHash } });
        await tick();
        requisicoes[1]?.responder({ exportacao: versaoAPI, lista: [], metadados: { geradoEm: '2026-09-12T12:00:00Z' } });
        await tick();
    }
    return { get, chamadas, requisicoes, context, tick, run: code => vm.runInContext(code, context) };
}
const fichaMock = key => ({ chave: key, exportacao: hash, candidato: { chave: key, nomeUrna: key }, documentos: { propostas: [{ sha256: hash, arquivo: `assets/proposta/${key}/${hash}.pdf` }, { sha256: outroHash, arquivo: `assets/proposta/${key}/${outroHash}.pdf` }] } });

test('script real rejeita ficha de exportação divergente e não usa localStorage', async () => {
    const app = await ambiente();
    const pending = app.run(`abrirFicha('${chave}')`);
    app.chamadas[0].responder({ ...fichaMock(chave), exportacao: outroHash });
    await pending;
    assert.match(app.get('msgResultados').textContent, /Exportação ausente ou divergente/);
    assert.equal(app.get('areaFicha').classList.contains('hidden'), true);
});

test('reabrir candidatura usa ficha em memória e ficha sem proposta não consulta resumo', async () => {
    const app = await ambiente();
    const primeira = app.run(`abrirFicha('${chave}')`);
    app.chamadas[0].responder({ ...fichaMock(chave), documentos: { propostas: [], certidoes: [] } });
    await primeira;
    assert.equal(app.chamadas.filter(c => c.url.startsWith('/api/candidato')).length, 1);
    assert.equal(app.chamadas.filter(c => c.url.startsWith('/api/resumo')).length, 0);
    app.get('btnVoltar').events.click();
    await app.run(`abrirFicha('${chave}')`);
    assert.equal(app.chamadas.filter(c => c.url.startsWith('/api/candidato')).length, 1);
    assert.equal(app.get('candIdHeader').textContent, chave);
});

test('script real ignora ficha atrasada e resumo após voltar', async () => {
    const app = await ambiente();
    const a = app.run(`abrirFicha('${chave}')`);
    const b = app.run(`abrirFicha('${outraChave}')`);
    app.chamadas[1].responder(fichaMock(outraChave)); await b;
    app.chamadas[0].responder(fichaMock(chave)); await a;
    assert.equal(app.get('candIdHeader').textContent, outraChave);
    const resumo = app.chamadas[2];
    assert.match(resumo.url, /exportacao=/);
    assert.equal(new URL(resumo.url, 'https://site.test').searchParams.get('id'), outraChave);
    app.get('btnVoltar').events.click();
    resumo.responder({ estado: 'resumo_publicado', afirmacoes: [{ texto: 'RESPOSTA ANTIGA' }] });
    await app.tick();
    assert.equal(app.get('resultadoIA').textContent, '');
    assert.equal(app.get('loadingIA').classList.contains('hidden'), true);
});

test('link legado passa intacto à API, POST usa chave resolvida e seleção explícita; modelo nunca é HTML', async () => {
    const app = await ambiente('BR_280002538811');
    assert.equal(new URL(app.chamadas[0].url, 'https://site.test').searchParams.get('id'), 'BR_280002538811');
    app.chamadas[0].responder(fichaMock(chave)); await app.tick();
    app.chamadas[1].responder({ chave, exportacao: hash, estado: 'rascunho_gerado', documentos: [{ sha256: hash }], afirmacoes: [{ tipo: 'proposta', tema: 'Saúde', texto: '<img src=x onerror=alert(1)>', referencias: [{ sha256: hash, pagina: 1 }] }] });
    await app.tick();
    assert.match(app.get('resultadoIA').textContent, /NÃO REVISADO/);
    assert.match(app.get('resultadoIA').textContent, /<img src=x/);
    assert.equal(app.get('resultadoIA').querySelectorAll('*').some(n => n.tag === 'img'), false);
    assert.equal(app.get('btnGerarResumo').disabled, true);
    const inputs = app.get('opcoesDocumentos').querySelectorAll('*').filter(n => n.tag === 'input');
    assert.equal(inputs.length, 2, 'metadados do resumo não escondem o segundo PDF');
    assert.equal(inputs.some(n => n.checked), false);
    assert.ok(app.get('resultadoIA').querySelectorAll('*').some(n => n.tag === 'a' && n.href.endsWith('#page=1')), 'referência preserva caminho validado do original');
    inputs[1].checked = true; inputs[1].events.change();
    app.get('btnGerarResumo').events.click();
    assert.deepEqual(JSON.parse(app.chamadas[2].options.body), { id_candidato: chave, exportacao: hash, documentos: [outroHash] });
    app.chamadas[2].responder({ chave, exportacao: hash, estado: 'resumo_publicado', afirmacoes: [] }); await app.tick();
    assert.match(app.get('resultadoIA').textContent, /Resumo publicado/);
    assert.equal(app.get('btnGerarResumo').disabled, true);
});

test('todos os estados do resumo são explícitos e flags legadas não publicam', async () => {
    const app = await ambiente();
    for (const [estado, label] of Object.entries(helpers.estadosResumo)) {
        app.run(`exibirResumo(${JSON.stringify({ estado, afirmacoes: [{ tipo: 'proposta', tema: 'Economia', texto: 'CONTEUDO' }] })})`);
        assert.ok(app.get('resultadoIA').textContent.includes(label));
        const apresenta = ['rascunho_gerado', 'resumo_publicado'].includes(estado);
        assert.equal(app.get('resultadoIA').textContent.includes('CONTEUDO'), apresenta);
    }
    app.run(`exibirResumo({ cached: true, resumo: '<b>LEGADO</b>', afirmacoes: [{ texto: 'CONTEUDO' }] })`);
    assert.match(app.get('resultadoIA').textContent, /Estado de resumo não reconhecido/);
    assert.equal(app.get('resultadoIA').textContent.includes('CONTEUDO'), false);
});

test('aviso de IA não aparece sem conteúdo; processamento_offline_necessario não afirma geração', async () => {
    const app = await ambiente();
    // revisao_necessaria sem afirmações: não deve mostrar "Conteúdo gerado por IA"
    app.run(`exibirResumo(${JSON.stringify({ estado: 'revisao_necessaria', afirmacoes: [], motivo: 'rascunho_ausente' })})`);
    assert.doesNotMatch(app.get('resultadoIA').textContent, /Conteúdo gerado por IA/);
    assert.match(app.get('resultadoIA').textContent, /Controles da fonte exigem revisão/);
    // Estados sem rascunho nunca exibem afirmações recebidas indevidamente.
    app.run(`exibirResumo(${JSON.stringify({ estado: 'revisao_necessaria', afirmacoes: [{ tipo: 'proposta', tema: 'Saúde', texto: 'Construir hospitais', referencias: [{ sha256: hash, pagina: 1 }] }] })})`);
    assert.doesNotMatch(app.get('resultadoIA').textContent, /Conteúdo gerado por IA|Construir hospitais/);
    // processamento_offline_necessario: não afirma que IA gerou conteúdo
    app.run(`exibirResumo(${JSON.stringify({ estado: 'processamento_offline_necessario', motivo: 'Plano extenso', afirmacoes: [] })})`);
    assert.doesNotMatch(app.get('resultadoIA').textContent, /Conteúdo gerado por IA/);
    assert.match(app.get('resultadoIA').textContent, /processamento antecipado/i);
    // resumo_publicado vazio ainda mostra aviso de IA (foi revisado)
    app.run(`exibirResumo(${JSON.stringify({ estado: 'resumo_publicado', afirmacoes: [] })})`);
    assert.match(app.get('resultadoIA').textContent, /Conteúdo gerado por IA/);
});

test('resumo atrasado de A não altera resumo nem loading de B', async () => {
    const app = await ambiente();
    const a = app.run(`abrirFicha('${chave}')`);
    app.chamadas[0].responder(fichaMock(chave)); await a;
    const b = app.run(`abrirFicha('${outraChave}')`);
    app.chamadas[2].responder(fichaMock(outraChave)); await b;
    app.chamadas[1].responder({ estado: 'resumo_publicado', afirmacoes: [{ texto: 'ANTIGO' }] }); await app.tick();
    assert.equal(app.get('resultadoIA').textContent, '');
    assert.equal(app.get('loadingIA').classList.contains('hidden'), false);
    app.chamadas[3].responder({ chave: outraChave, exportacao: hash, estado: 'extracao_pendente', afirmacoes: [] }); await app.tick();
    assert.match(app.get('resultadoIA').textContent, /Extração pendente/);
    assert.equal(app.get('btnGerarResumo').disabled, true);
    assert.equal(app.get('btnConsultarResumo').disabled, false);
});

test('scripts inline do HTML têm sintaxe válida e não há fallback remoto de foto', async () => {
    const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
    for (const match of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)) new vm.Script(match[1]);
    assert.match(html, /name="public-base" content="\/"/);
    assert.doesNotMatch(html, /onerror=|data:image|04\/09\/2026/);
});

test('exportacao.json precede a API, respeita public-base e deve coincidir', async () => {
    const app = await ambiente(null, { base: '/deploy/' });
    assert.deepEqual(app.requisicoes.map(r => r.url), ['/deploy/exportacao.json', `/deploy/busca/${hash}.${outroHash}.json`]);
    assert.equal(app.requisicoes[0].options.cache, 'no-cache');
    assert.equal(app.requisicoes[1].options.cache, 'force-cache');
    assert.equal(app.get('btnPesquisar').disabled, false);
    const divergente = await ambiente(null, { versaoAPI: outroHash });
    assert.match(divergente.get('msgResultados').textContent, /índice estático divergente/);
    assert.equal(divergente.get('btnPesquisar').disabled, true);
    assert.equal(divergente.run('exportacao'), null);
});

test('sem arquivo de build ou hash válido não há fallback nem chamada à API', async () => {
    for (const [data, status] of [[{ erro: 'Não encontrado' }, 404], [{ versao: 'invalida' }, 200]]) {
        const app = await ambiente(null, { inicializar: false });
        assert.equal(app.requisicoes[0].url, '/exportacao.json');
        app.requisicoes[0].responder(data, status); await app.tick();
        assert.equal(app.chamadas.length, 0);
        assert.equal(app.get('btnPesquisar').disabled, true);
        assert.match(app.get('msgResultados').textContent, /exportacao.json do build é obrigatório, inclusive em desenvolvimento/);
    }
});

function camposExibidos(node) {
    return new Map(node.querySelectorAll('*').filter(n => n.children[0]?.tag === 'dt')
        .map(n => [n.children[0].textContent, n.children[1].textContent]));
}

test('cadastro omite gênero/cor/raça inclusive técnicos e usa situacaoCandidatura', async () => {
    const app = await ambiente();
    app.run(`renderizarCadastro(${JSON.stringify({ situacaoCandidatura: 'APTO', situacao: 'LEGADO', genero: 'CADASTRO G', corRaca: 'CADASTRO C', generoFEFC: 'FEFC G', corRacaFEFC: 'FEFC C' })})`);
    const campos = camposExibidos(app.get('conteudoDadosCandidato'));
    assert.equal(campos.get('Situação da candidatura'), 'APTO');
    assert.doesNotMatch(app.get('conteudoDadosCandidato').textContent, /gênero|cor.?raça|genero|corRaca|CADASTRO [GC]|FEFC/i);
});

test('financeiro mantém registros originários repetidos, limite null e contagens explícitas', async () => {
    const app = await ambiente();
    const fin = { limite_gastos_centavos: null, quantidade_receitas: 0, quantidade_despesas_contratadas: 2,
        quantidade_despesas_pagas: 3, doadoresOriginarios: [{ NM_DOADOR_ORIGINARIO: 'Repetido' }, { NM_DOADOR_ORIGINARIO: 'Repetido' }],
        prestadores: [{ TP_PRESTACAO_CONTAS: 'FINAL', DT_PRESTACAO_CONTAS: '01/09/2026', NR_TURNO: '1' }] };
    app.run(`renderizarFinanceiro(${JSON.stringify(fin)}, {})`);
    const el = app.get('conteudoFinanceiro'), campos = camposExibidos(el);
    const prestacoes = el.children.find(n => n.children[0]?.textContent?.startsWith('Prestações:'));
    assert.equal(camposExibidos(el).get('Tipo de prestação (TSE)'), undefined, 'seção fechada não cria campos');
    prestacoes.open = true; prestacoes.events.toggle();
    const limite = el.querySelectorAll('*').find(n => n.children[0]?.textContent === 'Limite de gastos');
    assert.equal(limite.children[1].textContent, 'Não informado');
    assert.equal(campos.get('Receitas — registros'), '0');
    assert.equal(campos.get('Despesas contratadas — itens contratados'), '2');
    assert.equal(campos.get('Pagamentos — parcelas pagas'), '3');
    assert.equal(campos.get('Originários — registros, não doadores únicos'), '2');
    const camposAbertos = camposExibidos(el);
    assert.equal(camposAbertos.get('Tipo de prestação (TSE)'), 'FINAL');
    assert.equal(camposAbertos.get('Data de prestação (TSE)'), '01/09/2026');
    assert.equal(camposAbertos.get('Turno (TSE)'), '1');
    const originarios = el.children.find(n => n.children[0]?.textContent === 'Originários — registros, não doadores únicos — detalhes e campos TSE');
    assert.equal((originarios.textContent.match(/Repetido/g) ?? []).length, 0, 'seção fechada não materializa registros');
    originarios.open = true; originarios.events.toggle();
    const registros = originarios.children.filter(n => n.children[0]?.textContent?.startsWith('Registro '));
    registros.forEach(registro => { registro.open = true; registro.events.toggle(); });
    assert.equal((originarios.textContent.match(/Repetido/g) ?? []).length, 2);
});

async function abrirComResumoInicial() {
    const app = await ambiente();
    const pending = app.run(`abrirFicha('${chave}')`);
    app.chamadas[0].responder(fichaMock(chave)); await pending;
    app.chamadas[1].responder({ chave, exportacao: hash, estado: 'revisao_necessaria', motivo: 'selecao_documentos_obrigatoria' });
    await app.tick();
    return app;
}

test('GET repete documentos, preserva seleção e mostra motivo/OCR/escopo do subconjunto', async () => {
    const app = await abrirComResumoInicial();
    assert.match(app.get('resultadoIA').textContent, /Motivo: selecao_documentos_obrigatoria/);
    const inputs = app.get('opcoesDocumentos').querySelectorAll('*').filter(n => n.tag === 'input');
    inputs.forEach(input => { input.checked = true; input.events.change(); });
    app.get('btnConsultarResumo').events.click();
    assert.deepEqual(new URL(app.chamadas[2].url, 'https://site.test').searchParams.getAll('documentos'), [hash, outroHash]);
    app.chamadas[2].responder({ chave, exportacao: hash, estado: 'rascunho_gerado', documentos: [{ sha256: hash }, { sha256: outroHash }], documentosSelecionados: [hash, outroHash], afirmacoes: [] });
    await app.tick();
    const novos = app.get('opcoesDocumentos').querySelectorAll('*').filter(n => n.tag === 'input');
    assert.ok(novos.every(n => n.checked));
    novos[1].checked = false; novos[1].events.change();
    assert.equal(app.get('resultadoIA').textContent, '', 'não conserva resumo da seleção anterior');
    app.get('btnConsultarResumo').events.click();
    assert.deepEqual(new URL(app.chamadas[3].url, 'https://site.test').searchParams.getAll('documentos'), [hash]);
    app.chamadas[3].responder({ chave, exportacao: hash, estado: 'revisao_necessaria', motivo: '<b>Conferir OCR</b>', avisoRevisaoOCR: true, documentosSelecionados: [hash], documentos: [{ sha256: hash }], afirmacoes: [] });
    await app.tick();
    const result = app.get('resultadoIA');
    assert.match(result.textContent, /Motivo: <b>Conferir OCR<\/b>/);
    assert.match(result.textContent, /Alerta OCR/);
    assert.match(result.textContent, /1 de 2 PDF/);
    assert.match(result.textContent, /Seleção de subconjunto: não representa todas as propostas/);
    assert.equal(result.querySelectorAll('*').some(n => n.tag === 'b'), false);
    assert.equal(app.get('opcoesDocumentos').querySelectorAll('input:checked').length, 1);
});

test('bens: top 5 exato e demais registros permanecem paginados sob demanda', async () => {
    const app = await ambiente();
    const bens = ['0', '9007199254740993000', null, '-1', '9007199254740993001', '12', '50'].map((valorCentavos, i) => ({ valorCentavos, DS_BEM_CANDIDATO: `Bem ${i}` }));
    app.context.patrimonioTeste = { status: 'ok', bens, totalCentavos: '18014398509481986062' };
    app.run('renderizarPatrimonio(patrimonioTeste)');
    const el = app.get('conteudoPatrimonio');
    const lista = el.children.find(n => n.className === 'cand-patr-itens');
    const nomes = () => lista.children.map(n => n.children[0].children[1].textContent);
    assert.deepEqual(nomes(), ['Bem 4', 'Bem 1', 'Bem 6', 'Bem 5', 'Bem 0']);
    const detalhesTodos = el.children.find(n => n.tag === 'details' && n.children[0]?.textContent.includes('todos os 7 bens'));
    assert.ok(detalhesTodos);
    assert.equal(detalhesTodos.children.length, 2, 'lista fechada contém só cabeçalho e controle de paginação');
    assert.equal(lista.children.length, 5);
    assert.equal(bens[0].DS_BEM_CANDIDATO, 'Bem 0');
    app.run('renderizarPatrimonio({status: "ok", bens: []})');
    assert.equal(el.children.some(n => n.tag === 'button'), false);
});

test('resumo mostra apenas propostas agrupadas por tema e mantém referências', async () => {
    const app = await abrirComResumoInicial();
    const afirmacoes = [
        { tipo: 'biografia', tema: 'Saúde', texto: 'BIOGRAFIA OCULTA' },
        { tipo: 'opiniao', tema: 'Economia', texto: 'OPINIAO OCULTA' },
        { tipo: 'proposta', tema: 'Saúde', texto: 'Construir hospitais', referencias: [{ sha256: hash, pagina: 2 }] },
        { tipo: 'proposta', tema: 'Economia', texto: 'Simplificar tributos' },
        { tipo: 'proposta', tema: 'Saúde', texto: 'Ampliar equipes' },
        { tipo: 'proposta', tema: 'Tema desconhecido', texto: 'Outra proposta' },
        null,
    ];
    app.run(`exibirResumo(${JSON.stringify({ estado: 'rascunho_gerado', afirmacoes })})`);
    const el = app.get('resultadoIA');
    const grupos = el.children.filter(n => n.tag === 'section');
    assert.deepEqual(grupos.map(n => n.children[0].textContent), ['Economia', 'Saúde', 'Outros']);
    assert.match(grupos[1].textContent, /Construir hospitais.*Ampliar equipes/);
    assert.doesNotMatch(el.textContent, /BIOGRAFIA OCULTA|OPINIAO OCULTA/);
    assert.ok(el.querySelectorAll('*').some(n => n.tag === 'a' && n.href.endsWith('#page=2')));
    assert.deepEqual(helpers.temasPropostas, ['Economia', 'Saúde', 'Segurança', 'Meio Ambiente', 'Educação', 'Infraestrutura', 'Habitação', 'Assistência Social', 'Gestão Pública', 'Outros']);
});

test('certidões recolhidas com contagem, PDF de proposta e ressalva legal visíveis', async () => {
    const app = await abrirComResumoInicial();
    const docs = { propostas: fichaMock(chave).documentos.propostas, certidoes: [{ nome: 'Certidão judicial', sha256: hash, arquivo: `assets/certidao/${chave}/${hash}.pdf` }] };
    app.run(`renderizarJuridico({}, ${JSON.stringify(docs)}, {})`);
    const el = app.get('conteudoDocumentosJuridicos');
    const certidoes = el.children.find(n => n.tag === 'details' && n.children[0].textContent === 'Certidões (1)');
    assert.ok(certidoes);
    assert.ok(!certidoes.open);
    assert.equal(certidoes.children.length, 1, 'certidões fechadas criam somente o cabeçalho');
    certidoes.open = true; certidoes.events.toggle();
    assert.equal(certidoes.querySelectorAll('*').filter(n => n.tag === 'a').length, 1);
    assert.match(el.children[0].textContent, /não significa “nada consta”/);
    assert.equal(el.children[0].tag, 'p');
    const propostas = el.children.find(n => n.children[0]?.textContent === 'Propostas de governo (2)');
    assert.equal(propostas.tag, 'div');
    assert.equal(propostas.querySelectorAll('*').filter(n => n.tag === 'a').length, 2);
    const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
    assert.ok(html.indexOf('id="conteudoFinanceiro"') < html.indexOf('id="conteudoPatrimonio"'));
    assert.match(html, /id="loadingIA"[^>]*role="status"[^>]*aria-live="polite"/);
});

test('geração dá feedback imediato, impede repetição e recupera controles em 429/503', async () => {
    const app = await abrirComResumoInicial();
    const input = app.get('opcoesDocumentos').querySelectorAll('*').find(n => n.tag === 'input');
    input.checked = true; input.events.change();
    for (const status of [429, 503]) {
        const antes = app.chamadas.length;
        const pending = app.get('btnGerarResumo').events.click();
        assert.equal(app.get('btnGerarResumo').disabled, true);
        assert.equal(app.get('btnConsultarResumo').disabled, true);
        assert.equal(app.get('selecaoDocumentos').disabled, true);
        assert.match(app.get('loadingIA').textContent, /Gerando propostas por tema/);
        assert.equal(app.get('loadingIA').classList.contains('hidden'), false);
        await app.get('btnGerarResumo').events.click();
        assert.equal(app.chamadas.length, antes + 1);
        app.chamadas.at(-1).responder(null, status);
        await pending;
        assert.match(app.get('resultadoIA').textContent, new RegExp(String(status)));
        assert.match(app.get('resultadoIA').textContent, /Falha HTTP/);
        assert.doesNotMatch(app.get('resultadoIA').textContent, /Aguarde (um minuto|alguns instantes)/i);
        assert.equal(app.get('btnGerarResumo').disabled, false);
        assert.equal(app.get('btnConsultarResumo').disabled, false);
        assert.equal(app.get('selecaoDocumentos').disabled, false);
        assert.equal(app.get('loadingIA').classList.contains('hidden'), true);
    }
});

test('prazo cancela transporte mesmo se a operação não responder e navegação cancela espera', async () => {
    let signal;
    await assert.rejects(helpers.comPrazo(s => { signal = s; return new Promise(() => {}); }, undefined, 5), /30 segundos.*Consulte o estado/);
    assert.equal(signal.aborted, true);
    const controller = new AbortController();
    const pending = helpers.comPrazo(s => { signal = s; return new Promise(() => {}); }, controller.signal);
    controller.abort();
    await assert.rejects(pending, /cancelada/);
    assert.equal(signal.aborted, true);
    assert.equal(await helpers.comPrazo(async () => 'ok'), 'ok');
});

test('timeout do resumo libera botões e não exibe resposta tardia', async () => {
    const app = await abrirComResumoInicial();
    app.context.comPrazo = (operacao, signal) => helpers.comPrazo(operacao, signal, 5);
    const input = app.get('opcoesDocumentos').querySelectorAll('*').find(n => n.tag === 'input');
    input.checked = true; input.events.change();
    const pending = app.get('btnGerarResumo').events.click();
    const requisicao = app.chamadas.at(-1);
    await pending;
    assert.equal(requisicao.options.signal.aborted, true);
    assert.match(app.get('resultadoIA').textContent, /30 segundos.*Consulte o estado/);
    assert.equal(app.get('btnGerarResumo').disabled, false);
    assert.equal(app.get('loadingIA').classList.contains('hidden'), true);
    requisicao.responder({ chave, exportacao: hash, estado: 'resumo_publicado', afirmacoes: [{ tipo: 'proposta', tema: 'Saúde', texto: 'RESPOSTA TARDIA' }] });
    await app.tick();
    assert.doesNotMatch(app.get('resultadoIA').textContent, /RESPOSTA TARDIA|Resumo publicado/);
});

test('resumo exige eco de chave e exportação em todo sucesso HTTP', async () => {
    const app = await abrirComResumoInicial();
    for (const eco of [{ chave }, { exportacao: hash }, { chave: outraChave, exportacao: hash }, { chave, exportacao: outroHash }]) {
        app.get('btnConsultarResumo').events.click();
        app.chamadas.at(-1).responder({ ...eco, estado: 'resumo_publicado', afirmacoes: [{ texto: 'NÃO EXIBIR' }] });
        await app.tick();
        assert.match(app.get('resultadoIA').textContent, /Erro na consulta do resumo/);
        assert.doesNotMatch(app.get('resultadoIA').textContent, /NÃO EXIBIR|Resumo publicado/);
    }
});
