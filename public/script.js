import {
    chaveCanonica, identificadorAPI, hashValido, fmtCentavos, compararBens, estadosDados,
    valorFinanceiro, publicBase, assetURL, filtrarLista, estadosResumo,
    selecaoDocumentos, criarControleRequisicao, agruparPropostas, comPrazo,
    descritorIndice, criarCacheLimitado,
} from './frontend-helpers.mjs';

const $ = id => document.getElementById(id);
const base = publicBase(document.querySelector('meta[name="public-base"]')?.content);
const placeholder = base + 'icons/candidato-placeholder.svg';
const fichaControle = criarControleRequisicao();
const resumoControle = criarControleRequisicao();
const cacheFichas = criarCacheLimitado(12);
const cacheDetalhes = criarCacheLimitado(48);
let listaBusca = [], exportacao = null, metadados = null, ficha = null;
let documentosResumo = [], resumoOcupado = false, resumoEstado = null;
let resumoDisponivel = null, resumoVisivel = false;

function elemento(tag, texto, classe) {
    const el = document.createElement(tag);
    if (texto != null) el.textContent = String(texto);
    if (classe) el.className = classe;
    return el;
}
function texto(value) {
    if (value == null || value === '') return 'Não informado';
    if (value === true) return 'Sim';
    if (value === false) return 'Não';
    return String(value);
}
function campo(container, label, value) {
    const item = elemento('div', null, 'cand-dados-item');
    item.append(elemento('dt', label), elemento('dd', texto(value)));
    container.append(item);
}
function campos(container, pares) {
    const dl = elemento('dl', null, 'cand-dados-dl');
    pares.forEach(([label, value]) => campo(dl, label, value));
    container.append(dl);
}
function montarDetalhe(box, value) {
    if (value == null) box.append(elemento('p', 'Não informado', 'texto-mutado'));
    else if (Array.isArray(value)) {
        box.append(elemento('p', `${value.length} registro(s) recebido(s).`));
        value.forEach((registro, i) => detalhes(box, `Registro ${i + 1}`, registro));
    } else if (typeof value === 'object') {
        const dl = elemento('dl', null, 'cand-dados-dl');
        Object.entries(value).forEach(([key, val]) => {
            if (val !== null && typeof val === 'object') detalhes(box, key, val);
            else campo(dl, key, /centavos/i.test(key) ? fmtCentavos(val) ?? 'Valor não informado' : val);
        });
        box.append(dl);
    } else box.append(elemento('p', texto(value)));
}
// Cria somente o cabeçalho; a árvore interna nasce uma vez na primeira abertura.
function detalhes(container, titulo, value) {
    const box = elemento('details', null, 'cand-dados-extra');
    box.append(elemento('summary', titulo));
    let montado = false;
    box.addEventListener('toggle', () => {
        if (box.open && !montado) { montado = true; montarDetalhe(box, value); }
    });
    container.append(box);
    return box;
}
function grupoComplementar(container, titulo = 'Ver informações complementares e fontes') {
    const box = elemento('details', null, 'cand-dados-extra grupo-complementar');
    box.append(elemento('summary', titulo));
    container.append(box);
    return box;
}
function detalhesRemotos(container, titulo, carregar) {
    const box = elemento('details', null, 'cand-dados-extra');
    box.append(elemento('summary', titulo));
    let iniciado = false;
    box.addEventListener('toggle', async () => {
        if (!box.open || iniciado) return;
        iniciado = true; const contexto = ficha;
        const status = elemento('p', 'Carregando detalhes…', 'texto-mutado'); box.append(status);
        try {
            const valor = await carregar();
            if (ficha !== contexto) return;
            status.remove?.(); montarDetalhe(box, valor);
        } catch (erro) {
            if (ficha === contexto) status.textContent = `Detalhes indisponíveis: ${erro.message}`;
        }
    });
    container.append(box); return box;
}
function detalhesPaginados(container, titulo, carregarPagina) {
    const box = elemento('details', null, 'cand-dados-extra');
    box.append(elemento('summary', titulo));
    let pagina = 0, carregando = false, finalizado = false;
    const botao = elemento('button', 'Carregar primeiros 100 registros', 'btn-secundario');
    botao.type = 'button';
    async function carregar() {
        if (carregando || finalizado || !ficha) return;
        carregando = true; botao.disabled = true; botao.textContent = 'Carregando…';
        const contexto = ficha;
        try {
            const data = await carregarPagina(pagina + 1);
            if (ficha !== contexto) return;
            pagina = data.pagina;
            data.itens.forEach((registro, i) => detalhes(box, `Registro ${(pagina - 1) * data.limite + i + 1}`, registro));
            finalizado = !data.temMais;
            botao.textContent = finalizado ? `${data.total} registro(s) carregado(s)` : 'Carregar próximos 100 registros';
            botao.disabled = finalizado;
        } catch (erro) { botao.textContent = `Tentar novamente — ${erro.message}`; }
        finally { carregando = false; if (!finalizado) botao.disabled = false; }
    }
    box.addEventListener('toggle', () => { if (box.open && pagina === 0) void carregar(); });
    botao.addEventListener('click', () => void carregar()); box.append(botao); container.append(box);
    return box;
}
function fonte(container, metadata = metadados) {
    container.append(elemento('p', 'A geração da exportação não é a data de coleta ou atualização das fontes TSE. Dados sujeitos a retificação.', 'texto-mutado'));
    detalhes(container, 'Metadados públicos da exportação e das fontes', metadata);
    const link = elemento('a', 'Consultar dados oficiais no Portal DivulgaCand');
    link.href = 'https://divulgacandcontas.tse.jus.br';
    link.target = '_blank'; link.rel = 'noopener noreferrer'; container.append(link);
}
function atualizarDatas() {
    const raw = metadados?.geradoEm;
    const date = raw ? new Date(raw) : null;
    const value = date && !Number.isNaN(date.getTime()) ? date.toLocaleString('pt-BR') : 'Não informada';
    document.querySelectorAll('[data-data-geracao]').forEach(el => { el.textContent = value; });
}
async function jsonAPI(url, options = {}) {
    const response = await fetch(url, { cache: 'no-store', ...options });
    let data;
    try { data = await response.json(); } catch { throw new Error(`Resposta inválida da API (HTTP ${response.status}).`); }
    if (!response.ok) {
        const retryAfter = parseInt(response.headers?.get?.('Retry-After') ?? data?.retryAfter ?? '0', 10);
        const espera = retryAfter >= 86400 ? `${Math.ceil(retryAfter / 86400)} dia(s)` : retryAfter >= 3600
            ? `${Math.ceil(retryAfter / 3600)} hora(s)` : retryAfter >= 60 ? `${Math.ceil(retryAfter / 60)} minuto(s)`
                : retryAfter > 0 ? `${retryAfter}s` : null;
        const motivo = [data?.erro, data?.mensagem, data?.motivo].filter(Boolean).map(texto).join(' — ');
        throw new Error(`${motivo || `Falha HTTP ${response.status}`}${espera ? ` Tente novamente após ${espera}.` : ''}`);
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Formato inválido da API.');
    return data;
}
function validarVersao(data, esperada) {
    if (!hashValido(data.exportacao) || data.exportacao !== esperada) {
        throw new Error('Exportação ausente ou divergente. Recarregue a página para consultar a versão atual.');
    }
}
async function carregarListaBusca() {
    $('btnPesquisar').disabled = true;
    $('msgResultados').textContent = 'Verificando versão dos assets e carregando índice de busca...';
    listaBusca = []; exportacao = null;
    try {
        let assets, descritor;
        try {
            assets = await jsonAPI(base + 'exportacao.json', { cache: 'no-cache' });
            descritor = descritorIndice(assets);
            if (!descritor) throw new Error('Descritor do índice ausente ou inválido.');
        } catch (error) {
            throw new Error(`exportacao.json do build é obrigatório, inclusive em desenvolvimento. ${error.message}`);
        }
        const data = await jsonAPI(base + descritor.arquivo, { cache: 'force-cache' });
        if (data.exportacao !== assets.versao) throw new Error('Versão do índice estático divergente do ponteiro público. Recarregue a página.');
        if (!hashValido(data.exportacao) || !Array.isArray(data.lista) || !data.metadados ||
            data.lista.some(c => !c || !chaveCanonica(c.chave))) throw new Error('Índice de busca inválido ou sem versão.');
        listaBusca = data.lista;
        exportacao = data.exportacao;
        metadados = data.metadados;
        atualizarDatas();
        $('btnPesquisar').disabled = false;
        $('msgResultados').textContent = 'Digite um nome ou selecione os filtros para pesquisar.';
        const id = new URL(location.href).searchParams.get('id');
        if (id) await abrirFicha(id);
    } catch (error) {
        $('msgResultados').textContent = `Busca indisponível: ${error.message} Nenhum dado offline será utilizado.`;
    }
}
function pesquisar() {
    if (!exportacao) return;
    const busca = $('inputBusca').value.trim(), uf = $('selectUF').value, cargo = $('selectCargo').value;
    $('listaCandidatos').replaceChildren();
    if (!busca && !uf && !cargo) {
        $('msgResultados').textContent = 'Preencha pelo menos um campo de busca.';
        return;
    }
    const resultados = filtrarLista(listaBusca, busca, uf, cargo);
    $('msgResultados').textContent = `${resultados.length} candidato(s) encontrado(s).${resultados.length > 50 ? ' Exibindo os primeiros 50; refine os filtros.' : ''}`;
    resultados.slice(0, 50).forEach(cand => {
        const row = elemento('div');
        Object.assign(row.style, { display: 'flex', alignItems: 'center', gap: '15px', padding: '12px', borderBottom: '1px solid var(--border-color)' });
        const btn = elemento('button', 'Consultar', 'btn-info');
        btn.addEventListener('click', () => abrirFicha(cand.chave));
        const info = elemento('div');
        info.append(elemento('strong', cand.nome), elemento('br'), elemento('span', `${texto(cand.cargo)} • ${cand.uf === 'BR' ? 'Brasil (circunscrição nacional)' : texto(cand.uf)} • N.º ${texto(cand.numeroUrna)} • ${cand.chave}`, 'texto-mutado'));
        row.append(btn, info); $('listaCandidatos').append(row);
    });
}
function renderizarCadastro(cand, metadata = metadados) {
    const el = $('conteudoDadosCandidato'); el.replaceChildren();
    el.append(elemento('p', texto(cand.nomeCompleto ?? cand.nomeUrna), 'cand-nome-completo'));
    campos(el, [
        ['Nome de urna', cand.nomeUrna], ['N.º Candidatura', cand.numeroUrna], ['Partido', cand.partido],
        ['Cargo', cand.cargo], ['UF', cand.uf === 'BR' ? 'Brasil (circunscrição nacional)' : cand.uf],
        ['Situação da candidatura', cand.situacaoCandidatura],
        ['Instrução', cand.instrucao], ['Ocupação', cand.ocupacao],
        ['Candidatura à reeleição', cand.tentandoReeleicao],
    ]);
    const complementares = grupoComplementar(el);
    detalhes(complementares, 'Unidade eleitoral', cand.unidadeEleitoral);
    detalhes(complementares, 'Resultados por turno', cand.resultadosPorTurno);
    detalhes(complementares, 'Campos cadastrais recebidos do TSE', Object.fromEntries(Object.entries(cand).filter(([key]) => !/genero|corRaca/i.test(key))));
    detalhes(complementares, 'Metadados públicos da ficha', metadata);
    fonte(complementares, metadata);
}
function renderizarPatrimonio(patrimonio) {
    const el = $('conteudoPatrimonio'); el.replaceChildren();
    el.append(elemento('p', estadosDados[patrimonio?.status] ?? `Estado não informado ou não reconhecido: ${texto(patrimonio?.status)}`, 'texto-mutado'));
    if (patrimonio?.status === 'ok' || patrimonio?.status === 'parcial') {
        const bens = Array.isArray(patrimonio.topBens) ? [...patrimonio.topBens] :
            Array.isArray(patrimonio.bens) ? [...patrimonio.bens].sort(compararBens) : [];
        el.append(elemento('p', `${bens.length} bem(ns) na resposta`, 'cand-patr-quantidade'));
        const lista = elemento('div', null, 'cand-patr-itens');
        const renderizarBens = () => {
            lista.replaceChildren();
            bens.slice(0, 5).forEach(bem => {
                const item = elemento('div', null, 'cand-patr-item');
                const desc = elemento('div', null, 'cand-patr-item-desc');
                desc.append(elemento('span', texto(bem.DS_TIPO_BEM_CANDIDATO), 'cand-patr-tipo'), elemento('span', texto(bem.DS_BEM_CANDIDATO), 'cand-patr-desc'));
                item.append(desc, elemento('span', fmtCentavos(bem.valorCentavos) ?? 'Valor não informado', 'cand-patr-valor'));
                lista.append(item);
            });
        };
        renderizarBens();
        el.append(lista);
        const totalBens = patrimonio.quantidade ?? bens.length;
        if (totalBens > 5) detalhesPaginados(el, `Consultar todos os ${totalBens} bens`, pagina =>
            carregarDetalhe('patrimonio', { pagina, limite: 100 }));
        const total = elemento('div', null, 'cand-patr-total');
        total.append(elemento('span', 'Total declarado na exportação'), elemento('strong', fmtCentavos(patrimonio.totalCentavos) ?? 'Valor não informado'));
        el.append(total);
    }
    const complementares = grupoComplementar(el, 'Ver detalhes e fontes do patrimônio');
    detalhes(complementares, 'Dados completos do patrimônio', patrimonio);
    fonte(complementares);
}
function renderizarFinanceiro(fin, cand) {
    const el = $('conteudoFinanceiro'); el.replaceChildren();
    el.append(elemento('p', 'Receitas, despesas contratadas, pagamentos e doadores originários são conjuntos distintos. Não são deduplicados nem somados entre si. Valores estimáveis e retificações exigem consulta à fonte.', 'texto-mutado'));
    campos(el, [['Prestação de contas — código informado (não é julgamento)', cand.situacaoPrestacaoContas]]);
    if (!fin) {
        el.append(elemento('p', 'Dados financeiros não disponíveis.'));
        const complementares = grupoComplementar(el);
        fonte(complementares);
    } else {
        [
            ['Limite de gastos', 'limite_gastos_centavos', null],
            ['Total arrecadado', 'total_arrecadado_centavos', 'status_receitas'],
            ['Total contratado', 'total_contratado_centavos', 'status_contratadas'],
            ['Total pago', 'total_pago_centavos', 'status_pagamento'],
        ].forEach(([label, key, status]) => {
            const item = elemento('div', null, 'cand-fin-item');
            item.append(elemento('span', label), elemento('strong', status ? valorFinanceiro(fin[key], fin[status]) : fmtCentavos(fin[key]) ?? 'Não informado'));
            el.append(item);
        });
        campos(el, [
            ['Receitas — registros', fin.quantidade_receitas],
            ['Despesas contratadas — itens contratados', fin.quantidade_despesas_contratadas],
            ['Pagamentos — parcelas pagas', fin.quantidade_despesas_pagas],
            ['Originários — registros, não doadores únicos', Array.isArray(fin.doadoresOriginarios) ? fin.doadoresOriginarios.length : null],
        ]);
        const complementares = grupoComplementar(el, 'Ver movimentações, dados completos e fontes');
        for (const [key, label] of [['receitas', 'Receitas'], ['despesasContratadas', 'Despesas contratadas'], ['pagamentos', 'Pagamentos'], ['doadoresOriginarios', 'Originários — registros, não doadores únicos']]) {
            if (Array.isArray(fin[key])) detalhes(complementares, `${label} — detalhes e campos TSE`, fin[key]);
            else detalhesPaginados(complementares, `${label} — detalhes e campos TSE`, pagina =>
                carregarDetalhe('financeiro', { conjunto: key, pagina, limite: 100 }));
        }
        if (Array.isArray(fin.prestadores)) {
            const prestacoes = elemento('details', null, 'cand-dados-extra');
            prestacoes.append(elemento('summary', 'Prestações: tipo, data e turno (não é julgamento de regularidade)'));
            let montado = false;
            prestacoes.addEventListener('toggle', () => {
                if (!prestacoes.open || montado) return;
                montado = true;
                fin.prestadores.forEach(prestador => campos(prestacoes, [
                    ['Tipo de prestação (TSE)', prestador.TP_PRESTACAO_CONTAS],
                    ['Data de prestação (TSE)', prestador.DT_PRESTACAO_CONTAS],
                    ['Turno (TSE)', prestador.NR_TURNO],
                ]));
            });
            complementares.append(prestacoes);
        } else detalhesPaginados(complementares, 'Prestações: tipo, data e turno (não é julgamento de regularidade)', pagina =>
            carregarDetalhe('financeiro', { conjunto: 'prestadores', pagina, limite: 100 }));
        detalhes(complementares, 'Demais campos financeiros recebidos', Object.fromEntries(Object.entries(fin).filter(([, valor]) => !Array.isArray(valor))));
        fonte(complementares);
    }
}
function urlDocumento(doc, tipo) {
    if (!hashValido(doc?.sha256)) return null;
    return assetURL(doc.arquivo ?? doc.caminho, { base, tipo, chave: ficha.chave, sha256: doc.sha256 });
}
function documento(container, doc, tipo, metadadosContainer) {
    const box = elemento('div', null, 'cand-juridico-subsecao');
    const href = urlDocumento(doc, tipo);
    if (href) {
        const link = elemento('a', doc.nome ?? 'Abrir documento original');
        link.href = href; link.target = '_blank'; link.rel = 'noopener noreferrer'; box.append(link);
    } else box.append(elemento('p', 'Documento indisponível ou caminho/hash inválido.'));

    detalhes(metadadosContainer ?? box, `Metadados: ${doc.nome ?? 'documento original'}`, doc);
    container.append(box);
}
function renderizarJuridico(cand, docs, juridico) {
    const el = $('conteudoDocumentosJuridicos'); el.replaceChildren();
    el.append(elemento('p', 'Escopo: registros cadastrais e documentos disponibilizados pelo TSE, não uma consulta abrangente a tribunais. Ausência de registros ou certidões não significa “nada consta”. Certidões não implicam condenação ou irregularidade.', 'disclaimer-juridico-alerta'));
    campos(el, [
        ['Situação do julgamento', cand.statusJulgamento], ['Situação na urna', cand.situacaoUrna],
        ['N.º do processo', cand.nrProcesso], ['Situação do diploma', cand.situacaoDiploma],
        ['Situação eleitoral relacionada', cand.situacaoEleitoral], ['Situação da cassação', cand.situacaoCassacao],
    ]);
    const complementares = grupoComplementar(el, 'Ver dados jurídicos completos, metadados e fontes');
    detalhes(complementares, 'Registros jurídicos e escopo informado', juridico);
    for (const [key, tipo, label] of [['propostas', 'proposta', 'Propostas de governo'], ['certidoes', 'certidao', 'Certidões']]) {
        const items = Array.isArray(docs?.[key]) ? docs[key] : [];
        const secao = tipo === 'certidao' ? elemento('details', null, 'cand-dados-extra') : elemento('div');
        secao.append(elemento(tipo === 'certidao' ? 'summary' : 'h4', `${label} (${items.length})`, 'cand-juridico-subtitulo'));
        const montar = () => {
            if (secao._montado) return;
            secao._montado = true;
            if (!items.length) secao.append(elemento('p', 'Nenhum documento disponível na resposta.', 'texto-mutado'));
            items.forEach(doc => documento(secao, doc, tipo, complementares));
        };
        if (tipo === 'certidao') secao.addEventListener('toggle', () => { if (secao.open) montar(); });
        else montar();
        el.append(secao);
    }
    fonte(complementares);
}
function atualizarBotaoResumo() {
    const selecionados = documentosSelecionados();
    const bloqueado = ['documento_indisponivel', 'extracao_pendente',
        'processamento_offline_necessario', 'bloqueio_quota', 'bloqueio_configuracao'].includes(resumoEstado);
    const botao = $('btnGerarResumo');
    if (resumoOcupado) botao.textContent = resumoEstado === null ? 'Consultando resumo...' : 'Gerando resumo...';
    else if (resumoDisponivel) botao.textContent = resumoVisivel ? 'Ocultar resumo' : 'Mostrar resumo';
    else if (bloqueado) botao.textContent = resumoEstado === 'processamento_offline_necessario' ? 'Resumo em preparação' : 'Resumo indisponível';
    else if (documentosResumo.length > 1 && selecionados.length === 0) botao.textContent = 'Selecione os documentos para gerar';
    else botao.textContent = 'Gerar resumo com IA';
    botao.disabled = !ficha || resumoOcupado || (!resumoDisponivel && (bloqueado || selecionados.length === 0));
    $('selecaoDocumentos').disabled = resumoOcupado;
}
function documentosSelecionados() {
    return selecaoDocumentos(documentosResumo, [...$('selecaoDocumentos').querySelectorAll('input:checked')].map(input => input.value));
}
function renderizarSelecao(docs) {
    const selecionados = new Set(documentosSelecionados());
    documentosResumo = Array.isArray(docs) ? docs.filter(d => d && hashValido(d.sha256)) : [];
    const el = $('opcoesDocumentos'); el.replaceChildren();
    documentosResumo.forEach((doc, i) => {
        const label = elemento('label');
        label.style.display = 'block'; label.style.overflowWrap = 'anywhere';
        const input = elemento('input'); input.type = 'checkbox'; input.value = doc.sha256;
        // Um documento único não exige uma decisão do usuário. Com vários PDFs,
        // escolhas continuam sempre explícitas para não alterar o escopo do resumo.
        input.checked = selecionados.has(doc.sha256) || (documentosResumo.length === 1 && selecionados.size === 0);
        input.addEventListener('change', () => {
            resumoEstado = null; resumoDisponivel = null; resumoVisivel = false;
            $('resultadoIA').replaceChildren(); $('resultadoIA').classList.add('hidden');
            atualizarBotaoResumo();
        });
        label.append(input, document.createTextNode(` ${i + 1}. ${doc.nome ?? 'Proposta de governo (PDF)'}`));
        el.append(label);
        detalhes(el, `Detalhes técnicos do PDF ${i + 1}`, { sha256: doc.sha256 });
    });
    if (!documentosResumo.length) el.append(elemento('p', 'Nenhum documento com hash válido disponível para seleção.'));
    atualizarBotaoResumo();
}
function exibirResumo(data, selecaoSolicitada = []) {
    const el = $('resultadoIA'); el.replaceChildren(); el.classList.remove('hidden');
    resumoEstado = Object.hasOwn(estadosResumo, data.estado) ? data.estado : null;
    const estadoTexto = resumoEstado ? estadosResumo[resumoEstado] : 'Estado de resumo não reconhecido; conteúdo não exibido.';
    const selecionados = Array.isArray(data.documentosSelecionados) ? data.documentosSelecionados.filter(hashValido) : selecaoSolicitada;
    const total = new Set(documentosResumo.map(doc => doc.sha256)).size;
    const escopoTexto = selecionados.length
        ? `Escopo: ${selecionados.length} de ${total} PDF(s) disponíveis. ${selecionados.length < total ? 'Seleção de subconjunto: não representa todas as propostas.' : 'O resumo se limita aos documentos indicados; não garante cobertura integral do conteúdo.'}`
        : 'Escopo documental não confirmado. Não interprete este resultado como resumo completo de todos os PDFs.';
    const alertaOCR = data.avisoRevisaoOCR === true || documentosResumo.some(doc => selecionados.includes(doc.sha256) &&
        (doc.requerRevisaoOCR === true || (Array.isArray(doc.paginasParaRevisao) ? doc.paginasParaRevisao.length > 0 : doc.paginasParaRevisao > 0)));
    const grupos = ['rascunho_gerado', 'resumo_publicado'].includes(resumoEstado) ? agruparPropostas(data.afirmacoes) : [];
    const temResumo = grupos.length > 0 || resumoEstado === 'resumo_publicado';

    function adicionarDetalhesResumo(container) {
        container.append(elemento('p', estadoTexto));
        if (data.mensagem) container.append(elemento('p', data.mensagem));
        if (data.motivo) {
            if (typeof data.motivo === 'object') detalhes(container, 'Motivo informado pela API', data.motivo);
            else container.append(elemento('p', `Motivo: ${data.motivo}`));
        }
        container.append(elemento('p', escopoTexto));
        if (selecionados.length) detalhes(container, 'Hashes dos documentos abrangidos nesta consulta', selecionados);
        if (data.alertas) detalhes(container, 'Alertas informados pela API', data.alertas);
        if (data.documentos) detalhes(container, 'Documentos e rastreabilidade do resumo', data.documentos);
    }

    if (!temResumo) {
        el.append(elemento('p', estadoTexto, 'disclaimer-ia'));
        if (data.mensagem) el.append(elemento('p', data.mensagem));
        if (data.motivo) {
            if (typeof data.motivo === 'object') detalhes(el, 'Motivo informado pela API', data.motivo);
            else el.append(elemento('p', `Motivo: ${data.motivo}`));
        }
        const consulta = grupoComplementar(el, 'Ver escopo e detalhes da consulta');
        consulta.append(elemento('p', escopoTexto));
        if (selecionados.length) detalhes(consulta, 'Hashes dos documentos abrangidos nesta consulta', selecionados);
        if (data.alertas) detalhes(consulta, 'Alertas informados pela API', data.alertas);
        if (data.documentos) detalhes(consulta, 'Documentos e rastreabilidade do resumo', data.documentos);
        if (alertaOCR) el.append(elemento('p', 'Alerta OCR: há extração óptica sinalizada para revisão. Números, tabelas e ordem de leitura podem conter erros; confira o PDF original.', 'disclaimer-ia'));
        return;
    }

    const referencias = new Map();
    grupos.forEach(grupo => {
        const secao = elemento('details', null, 'resumo-tema');
        const cabecalho = elemento('summary');
        cabecalho.append(
            elemento('span', grupo.tema, 'resumo-tema-titulo'),
            elemento('span', `${grupo.propostas.length} proposta(s)`, 'resumo-tema-contagem'),
        );
        secao.append(cabecalho);
        grupo.propostas.forEach(afirmacao => {
            const item = elemento('div', null, 'resumo-proposta');
            const paragrafo = elemento('p', null, 'resumo-proposta-texto');
            paragrafo.append(document.createTextNode(afirmacao.texto));
            const refs = Array.isArray(afirmacao.referencias) ? afirmacao.referencias : [];
            refs.forEach(ref => {
                const pagina = Number.isSafeInteger(ref.pagina) && ref.pagina > 0 ? ref.pagina : null;
                if (!hashValido(ref.sha256) || !pagina) return;
                const chaveRef = `${ref.sha256}:${pagina}`;
                const doc = documentosResumo.find(d => d.sha256 === ref.sha256);
                const href = doc && urlDocumento(doc, 'proposta');
                if (!referencias.has(chaveRef)) referencias.set(chaveRef, {
                    numero: referencias.size + 1, pagina, doc, href,
                });
                const referencia = referencias.get(chaveRef);
                const marcador = elemento(href ? 'a' : 'span', `[${referencia.numero}]`, 'resumo-citacao');
                marcador.title = `${doc?.nome ?? 'PDF original'}, página ${pagina}`;
                marcador.setAttribute('aria-label', `Fonte ${referencia.numero}: ${doc?.nome ?? 'PDF original'}, página ${pagina}`);
                if (href) { marcador.href = `${href}#page=${pagina}`; marcador.target = '_blank'; marcador.rel = 'noopener noreferrer'; }
                paragrafo.append(document.createTextNode(' '), marcador);
            });
            item.append(paragrafo); secao.append(item);
        });
        el.append(secao);
    });

    if (!grupos.length) el.append(elemento('p', 'Nenhuma proposta estruturada disponível. Consulte os PDFs originais.'));
    if (referencias.size) {
        const box = elemento('details', null, 'cand-dados-extra resumo-referencias');
        box.append(elemento('summary', `Referências do resumo (${referencias.size} página(s))`));
        let montado = false;
        box.addEventListener('toggle', () => {
            if (!box.open || montado) return;
            montado = true;
            const lista = elemento('ol', null, 'resumo-referencias-lista');
            for (const referencia of referencias.values()) {
                const item = elemento('li');
                const label = `${referencia.doc?.nome ?? 'PDF original'} — página ${referencia.pagina}`;
                const node = elemento(referencia.href ? 'a' : 'span', label);
                if (referencia.href) { node.href = `${referencia.href}#page=${referencia.pagina}`; node.target = '_blank'; node.rel = 'noopener noreferrer'; }
                item.append(node); lista.append(item);
            }
            box.append(lista);
        });
        el.append(box);
    }
    el.append(elemento('p', 'Conteúdo gerado por IA, sujeito a erros e omissões. Confira as afirmações nos documentos originais.', 'disclaimer-ia'));
    if (alertaOCR) el.append(elemento('p', 'Alerta OCR: há extração óptica sinalizada para revisão. Números, tabelas e ordem de leitura podem conter erros; confira o PDF original.', 'disclaimer-ia'));
    const sobre = grupoComplementar(el, 'Sobre este resumo');
    adicionarDetalhesResumo(sobre);
}
async function solicitarResumo(gerar = false) {
    if (!ficha || resumoOcupado) return;
    const documentos = documentosSelecionados();
    if (gerar && documentos.length === 0) return;
    const contexto = ficha;
    const request = resumoControle.iniciar();
    resumoOcupado = true; atualizarBotaoResumo();
    $('loadingIA').textContent = gerar ? 'Gerando propostas por tema… Isso pode levar até 30 segundos. Não é necessário clicar novamente.' : 'Consultando o estado do resumo…';
    $('loadingIA').classList.remove('hidden');
    $('resultadoIA').replaceChildren(); $('resultadoIA').classList.add('hidden');
    try {
        const params = new URLSearchParams({ id: contexto.chave, exportacao: contexto.exportacao });
        documentos.forEach(hash => params.append('documentos', hash));
        const data = await comPrazo(signal => jsonAPI(gerar ? '/api/resumo' : `/api/resumo?${params}`, gerar ? {
            method: 'POST', signal, headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id_candidato: contexto.chave, exportacao: contexto.exportacao, documentos }),
        } : { signal }), request.signal);
        if (!request.vigente() || ficha !== contexto) return;
        validarVersao(data, contexto.exportacao);
        if (!chaveCanonica(data.chave) || data.chave !== contexto.chave) throw new Error('Chave do resumo ausente ou divergente.');
        if (Array.isArray(data.documentos) && !gerar) {
            // O resumo pode listar só os PDFs usados nele; mantenha as outras propostas
            // e os caminhos originais quando a API retornar apenas hashes/metadados.
            const porHash = new Map(documentosResumo.map(doc => [doc.sha256, doc]));
            for (const raw of data.documentos) {
                const doc = typeof raw === 'string' ? { sha256: raw } : raw;
                if (hashValido(doc?.sha256)) {
                    const anterior = porHash.get(doc.sha256);
                    porHash.set(doc.sha256, { ...anterior, ...doc,
                        arquivo: doc.arquivo ?? anterior?.arquivo, caminho: doc.caminho ?? anterior?.caminho });
                }
            }
            renderizarSelecao([...porHash.values()]);
        }
        exibirResumo(data, documentos);
        if (['rascunho_gerado', 'resumo_publicado'].includes(data.estado)) {
            resumoDisponivel = data; resumoVisivel = true;
        } else { resumoDisponivel = null; resumoVisivel = false; }
    } catch (error) {
        if (!request.vigente() || ficha !== contexto) return;
        exibirResumo({ estado: 'erro_geracao', mensagem: error.message });
    } finally {
        if (request.vigente() && ficha === contexto) {
            resumoOcupado = false; $('loadingIA').classList.add('hidden'); atualizarBotaoResumo();
        }
    }
}
function carregarDetalhe(secao, extras = {}) {
    if (!ficha) return Promise.reject(new Error('Ficha não está aberta.'));
    const contexto = ficha;
    const params = new URLSearchParams({ id: contexto.chave, exportacao: contexto.exportacao, secao,
        ...Object.fromEntries(Object.entries(extras).map(([k, v]) => [k, String(v)])) });
    const chaveCache = `${contexto.exportacao}:${contexto.chave}:${params}`;
    return cacheDetalhes.obter(chaveCache, async () => {
        const data = await jsonAPI(`/api/candidato?${params}`);
        validarVersao(data, contexto.exportacao);
        if (data.chave !== contexto.chave || data.secao !== secao) throw new Error('Detalhe pertence a outra candidatura ou seção.');
        return data;
    });
}

function resetarFicha() {
    resumoControle.cancelar(); ficha = null; resumoOcupado = false; resumoEstado = null;
    resumoDisponivel = null; resumoVisivel = false;
    documentosResumo = []; $('opcoesDocumentos').replaceChildren();
    $('resultadoIA').replaceChildren(); $('resultadoIA').classList.add('hidden');
    $('loadingIA').classList.add('hidden'); atualizarBotaoResumo();
    $('areaFicha').classList.add('hidden');
    document.querySelector('.barra-pesquisa').classList.remove('hidden');
    $('areaResultados').classList.remove('hidden');
}
async function abrirFicha(id) {
    const request = fichaControle.iniciar();
    resetarFicha();
    if (!identificadorAPI(id)) {
        $('msgResultados').textContent = 'Identificador inválido. Use uma chave canônica ou um link legado UF_SQ; nome, número e SQ isolado não identificam candidaturas.';
        return;
    }
    const versao = exportacao;
    $('msgResultados').textContent = 'Carregando dossiê...';
    try {
        const chaveCache = `${versao}:${id}`;
        const data = await cacheFichas.obter(chaveCache, () => jsonAPI(`/api/candidato?${new URLSearchParams({ id, exportacao: versao, modo: 'compacto' })}`, { signal: request.signal }));
        if (!request.vigente()) return;
        validarVersao(data, versao);
        if (!chaveCanonica(data.chave) || !data.candidato || (chaveCanonica(id) && data.chave !== id) ||
            (data.candidato.chave != null && data.candidato.chave !== data.chave)) throw new Error('Identidade da candidatura divergente.');
        ficha = data;
        const foto = $('candFoto');
        foto.onerror = () => { foto.onerror = null; foto.src = placeholder; foto.alt = 'Foto indisponível'; };
        foto.src = assetURL(data.foto?.arquivo, { base, tipo: 'foto', chave: data.chave, sha256: data.foto?.sha256 }) ?? placeholder;
        foto.alt = foto.src.endsWith('candidato-placeholder.svg') ? 'Foto indisponível' : `Foto de ${texto(data.candidato.nomeUrna)}`;
        $('candIdHeader').textContent = data.chave;
        $('candExportacao').textContent = data.exportacao;
        renderizarCadastro(data.candidato, data.metadados); renderizarPatrimonio(data.patrimonio);
        renderizarFinanceiro(data.financeiro, data.candidato);
        renderizarJuridico(data.candidato, data.documentos, data.juridico);
        renderizarSelecao(data.documentos?.propostas);
        const url = new URL(location.href); url.searchParams.set('id', data.chave);
        history.replaceState(null, '', url);
        $('msgResultados').textContent = '';
        document.querySelector('.barra-pesquisa').classList.add('hidden');
        $('areaResultados').classList.add('hidden'); $('areaFicha').classList.remove('hidden');
        if (Array.isArray(data.documentos?.propostas) && data.documentos.propostas.some(doc => hashValido(doc?.sha256))) {
            void solicitarResumo();
        }
    } catch (error) {
        if (request.vigente()) { resetarFicha(); $('msgResultados').textContent = `Ficha indisponível: ${error.message} Nenhum dado offline será utilizado.`; }
    }
}
$('btnPesquisar').addEventListener('click', pesquisar);
$('inputBusca').addEventListener('keydown', event => { if (event.key === 'Enter') pesquisar(); });
$('btnVoltar').addEventListener('click', () => {
    fichaControle.cancelar(); resetarFicha();
    const url = new URL(location.href); url.searchParams.delete('id'); history.replaceState(null, '', url);
    pesquisar();
});
window.addEventListener('popstate', () => {
    const id = new URL(location.href).searchParams.get('id');
    if (id && exportacao) void abrirFicha(id);
    else { fichaControle.cancelar(); resetarFicha(); }
});
$('btnGerarResumo').addEventListener('click', () => {
    if (resumoDisponivel) {
        if (resumoVisivel) {
            $('resultadoIA').classList.add('hidden'); resumoVisivel = false;
        } else {
            exibirResumo(resumoDisponivel, resumoDisponivel.documentosSelecionados ?? documentosSelecionados());
            resumoVisivel = true;
        }
        atualizarBotaoResumo();
        return;
    }
    return solicitarResumo(true);
});
// Não lê nem migra caches de fichas/favoritos por heurística. Links legados são resolvidos apenas pela API.
atualizarDatas();
void carregarListaBusca();
