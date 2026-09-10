// ==========================================
// 1. MAPEAMENTO DO DOM (Elementos da Tela)
// ==========================================
const inputBusca = document.getElementById('inputBusca');
const selectUF = document.getElementById('selectUF');
const selectCargo = document.getElementById('selectCargo');
const btnPesquisar = document.getElementById('btnPesquisar');
const areaResultados = document.getElementById('areaResultados');
const msgResultados = document.getElementById('msgResultados');
const listaCandidatos = document.getElementById('listaCandidatos');

// Elementos da Ficha (Dossiê)
const areaFicha = document.getElementById('areaFicha');
const btnVoltar = document.getElementById('btnVoltar');
const btnGerarResumo = document.getElementById('btnGerarResumo');
const loadingIA = document.getElementById('loadingIA');
const resultadoIA = document.getElementById('resultadoIA');

// Helper: retorna HTML do ícone com versão dupla (_b/_p) para alternar com tema
function icon(nome) {
    return '<span class="icon-img"><img class="img-b" src="icons/' + nome + '_b.svg" alt=""><img class="img-p" src="icons/' + nome + '_p.svg" alt=""></span>';
}

// Helper: retorna HTML do ícone com versão fixa (ex: em botões coloridos)
function iconFixed(nome, versao) {
    return '<span class="icon-img-fixed"><img src="icons/' + nome + '_' + versao + '.svg" alt=""></span>';
}

// Disclaimer de IA exibido junto a todo resumo
const DISCLAIMER_IA = '⚠️ Resumo gerado por Inteligência Artificial a partir do texto oficial da proposta de governo registrada no TSE. Pode conter imprecisões, omissões ou interpretações equivocadas. Consulte sempre o documento original para compreensão completa.';

// ==========================================
// 2. ESTADO DA APLICAÇÃO (Memória)
// ==========================================
let listaBusca = [];
let dadosCandidatos = null; // Só será carregado quando clicarem em Consultar
let candidatoAtual = null;
let dadosExtrasAtual = null; // Dados de api/candidato.js (foto, documentos, financeiro)

// ==========================================
// BLINDAGEM JURÍDICA — datas e rastreabilidade
// ==========================================

// URL do Google Forms para reporte de dados incorretos ou inconsistências
const URL_FORMULARIO_ERRO = 'https://forms.gle/TuFSsPBaY6XFYcrq7';

// Data de geração do JSON — atualizada ao carregar dados_candidatos.json
let dataGeracaoJson = '04/09/2026'; // fallback hardcoded

// Atualiza todos os elementos marcados com [data-data-geracao] na página
function atualizarDatasInterface() {
    document.querySelectorAll('[data-data-geracao]').forEach(el => {
        el.textContent = dataGeracaoJson;
    });
}

// Componente reutilizável: rodapé de rastreabilidade de fonte por tipo de dado
// tipo: 'candidato' | 'patrimonio' | 'juridico' | 'financeiro'
function criarDisclaimerFonte(tipo) {
    const links = {
        'financeiro': 'https://dadosabertos.tse.jus.br/dataset/prestacao-de-contas-eleitorais-2026',
        'candidato':  'https://dadosabertos.tse.jus.br/dataset/candidatos-2026',
        // 'juridico' aponta para candidatos-2026 pois os dados de situação/cassação
        // atualmente exibidos vêm desse dataset (não do processual-2026, que ainda
        // não foi integrado). Atualizar quando processual-2026 for integrado.
        'juridico':   'https://dadosabertos.tse.jus.br/dataset/candidatos-2026',
        'patrimonio': 'https://dadosabertos.tse.jus.br/dataset/candidatos-2026',
    };
    const link = links[tipo] || links['candidato'];
    // Ícone de link externo — alterna com tema (link_b = branco / link_p = preto)
    const iconeLink = '<span class="icon-img" style="margin-left:3px;vertical-align:middle;"><img class="img-b" src="icons/link_b.svg" alt=""><img class="img-p" src="icons/link_p.svg" alt=""></span>';
    return `<details class="disclaimer-fonte">
        <summary class="disclaimer-fonte-summary">
            <span class="disclaimer-fonte-titulo">⚠️ Dados brutos do TSE (<span data-data-geracao>${escaparHTML(dataGeracaoJson)}</span>)</span>
            <span class="disclaimer-fonte-toggle">
                <span class="toggle-recolhido">Ver ressalva e fonte ▾</span>
                <span class="toggle-expandido">Ocultar ▴</span>
            </span>
        </summary>
        <div class="disclaimer-fonte-corpo">
            Devido à rotina de prestação de contas governamental, valores e registros podem estar desatualizados ou em retificação contínua.
            <div class="disclaimer-fonte-link-box">
                <a href="${link}" target="_blank" rel="noopener noreferrer">Confira os dados oficiais no Portal DivulgaCand${iconeLink}</a>
            </div>
        </div>
    </details>`;
}

// Classificação semântica de status jurídico — 3 níveis para evitar presunção de culpa
// NUNCA usar binário (positivo vs atenção) — status pendentes NÃO são problemas
function classificarStatusJuridico(status) {
    if (!status) return 'status-neutro';
    const s = status.toUpperCase();
    // Status que indicam deferimento/aptidão
    if (s === 'DEFERIDO' || s === 'APTO' || s === 'REGULAR' || s === 'APROVADO') {
        return 'status-positivo';
    }
    // Status que indicam indeferimento/cassação — apenas estes recebem alerta
    if (s === 'INDEFERIDO' || s === 'CASSADO' || s === 'CANCELADO' || s === 'RECUSADO'
        || s.startsWith('CASSADO') || s.startsWith('INDEFERIDO')) {
        return 'status-atencao';
    }
    // Todo o resto: SUB JUDICE, PENDENTE, DEFERIDO COM RECURSO, AGUARDANDO etc.
    // são situações processuais normais — não indicam irregularidade
    return 'status-neutro';
}

// Normalizador de texto igual ao seu Python (remove acentos)
function normalizarTexto(texto) {
    if (!texto) return "";
    return texto.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
}

// Inicialização: Busca a lista leve ao abrir o site
async function carregarListaBusca() {
    try {
        const response = await fetch('lista_busca.json');
        listaBusca = await response.json();
    } catch (error) {
        msgResultados.innerHTML = icon('cancel') + ' Erro ao carregar o banco de dados principal.';
        console.error(error);
    }
}

// ==========================================
// 3. LÓGICA DE PESQUISA E FILTRO
// ==========================================
btnPesquisar.addEventListener('click', () => {
    const raw = inputBusca.value.trim();
    const uf = selectUF.value;
    const cargo = selectCargo.value;

    // Detecta se o input é número (apenas dígitos) ou nome
    const ehNumero = /^\d+$/.test(raw);
    const termo = ehNumero ? '' : normalizarTexto(raw);
    const numero = ehNumero ? raw : '';

    if (!raw && !uf && !cargo) {
        msgResultados.innerHTML = icon('warning') + ' Preencha pelo menos um campo (Nome, N.º, UF ou Cargo) para pesquisar.';
        listaCandidatos.innerHTML = '';
        return;
    }

    const filtrados = listaBusca.filter(cand => {
        // Usa o nomeBusca que já limpamos no Python
        const matchNome = !termo || (cand.nomeBusca && cand.nomeBusca.includes(termo));
        // Busca por número: compara o início do numeroUrna (permite digitar "13" e achar "130", "13", etc.)
        const matchNumero = !numero || (cand.numeroUrna && String(cand.numeroUrna).startsWith(numero));
        const matchUF = !uf || cand.uf === uf;
        const matchCargo = !cargo || cand.cargo === cargo;
        return matchNome && matchNumero && matchUF && matchCargo;
    });

    // Ordenação: se buscou por número, ordena numericamente crescente (13 → 130 → 131 …)
    // caso contrário, ordena alfabeticamente por nome
    if (numero) {
        filtrados.sort((a, b) => {
            const na = Number(a.numeroUrna) || 0;
            const nb = Number(b.numeroUrna) || 0;
            if (na !== nb) return na - nb;
            return (a.nome || '').localeCompare(b.nome || '');
        });
    } else {
        filtrados.sort((a, b) => (a.nome || '').localeCompare(b.nome || ''));
    }

    renderizarResultados(filtrados);
});

function renderizarResultados(resultados) {
    listaCandidatos.innerHTML = '';

    if (resultados.length === 0) {
        msgResultados.innerText = "Nenhum candidato encontrado com esses filtros.";
        return;
    }

    let exibidos = resultados;
    let aviso = "";
    if (resultados.length > 50) {
        exibidos = resultados.slice(0, 50);
        aviso = ' ' + icon('warning') + ' Exibindo apenas os 50 primeiros';
    }

    msgResultados.innerHTML = icon('pesquisa') + ' ' + resultados.length + ' candidato(s) encontrado(s).' + aviso;

    exibidos.forEach(cand => {
        const div = document.createElement('div');
        div.style.display = 'flex';
        div.style.alignItems = 'center';
        div.style.gap = '15px';
        div.style.padding = '12px';
        div.style.borderBottom = '1px solid var(--border-color)';

        const btn = document.createElement('button');
        btn.className = 'btn-info';
        btn.innerText = 'Consultar';
        btn.onclick = () => abrirFicha(cand.id, cand.uf);

        const info = document.createElement('div');
        const strong = document.createElement('strong');
        strong.textContent = cand.nome;
        info.appendChild(strong);
        info.appendChild(document.createElement('br'));
        const span = document.createElement('span');
        span.className = 'texto-mutado';
        span.textContent = `${cand.cargo || 'Cargo Indefinido'} • ${cand.uf}${cand.numeroUrna ? ' • N.º ' + cand.numeroUrna : ''} • ID: ${cand.id}`;
        info.appendChild(span);

        div.appendChild(btn);
        div.appendChild(info);
        listaCandidatos.appendChild(div);
    });
}

// ==========================================
// 4. ABRIR FICHA DO CANDIDATO (O Dossiê)
// ==========================================

// Helpers compartilhados entre as funções de renderização

// Escapa HTML para prevenir XSS — usar SEMPRE que interpolar dados externos em innerHTML
function escaparHTML(texto) {
    if (texto === null || texto === undefined) return '';
    const div = document.createElement('div');
    div.textContent = String(texto);
    return div.innerHTML;
}

// Normaliza valor: retorna null para vazios / não-divulgáveis
function normalizarValor(raw) {
    if (raw === null || raw === undefined) return null;
    const s = String(raw).trim();
    if (!s || s === 'null' || s === 'undefined') return null;
    const up = s.toUpperCase();
    if (up === 'NÃO DIVULGÁVEL' || up === 'NAO DIVULGAVEL') return null;
    return s;
}

// Mapeia "BR" para "Brasil", mantém outros valores como estão
function formatarUF(uf) {
    return uf === 'BR' ? 'Brasil' : uf;
}

// Converte indicador S/N em texto legível
function simNao(raw) {
    const s = normalizarValor(raw);
    if (!s) return null;
    const up = s.toUpperCase();
    if (up === 'S' || up === 'SIM') return 'Sim';
    if (up === 'N' || up === 'NÃO' || up === 'NAO') return 'Não';
    return s;
}

// Formata valor monetário em R$
function fmtMoeda(v) {
    return Number(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

// ── Card: Dados do Candidato ──────────────
function renderizarDadosCandidato(cand, fallback) {
    const el = document.getElementById('conteudoDadosCandidato');
    if (!el) return;

    const v = normalizarValor;

    // Fonte primária: data/candidatos.json (retornado pela API)
    const nomeCompleto = v(cand?.nomeCompleto) || v(fallback?.nome);
    const nomeUrna = v(cand?.nomeUrna) || v(fallback?.nomeUrna);
    const numero = v(cand?.numeroUrna);
    const cargo = v(cand?.cargo) || v(fallback?.cargo);
    const partido = v(cand?.partido) || v(fallback?.partido);
    const ufVal = v(cand?.uf);
    const situacao = v(cand?.situacao);

    let html = '';

    // Nome completo destacado
    if (nomeCompleto) {
        html += `<p class="cand-nome-completo">${escaparHTML(nomeCompleto)}</p>`;
    }
    if (nomeUrna && nomeUrna !== nomeCompleto) {
        html += `<p class="cand-nome-urna">Urna: <strong>${escaparHTML(nomeUrna)}</strong></p>`;
    }

    // Grid de campos
    const itens = [];
    const add = (label, valor) => { if (valor !== null) itens.push({ label, valor }); };

    add('N.º Candidatura', numero);
    add('Partido', partido);
    add('Cargo', cargo);
    add('UF', ufVal ? formatarUF(ufVal) : null);
    add('Situação da candidatura', situacao);

    if (itens.length > 0) {
        html += '<dl class="cand-dados-dl">';
        itens.forEach(({ label, valor }) => {
            html += `<div class="cand-dados-item"><dt>${escaparHTML(label)}</dt><dd>${escaparHTML(valor)}</dd></div>`;
        });
        html += '</dl>';
    }

    // Campos adicionais de perfil relevantes para contexto eleitoral
    // Gênero, estado civil e cor/raça foram removidos por serem irrelevantes ao contexto político
    const extraItens = [];
    const addExtra = (label, valor) => { if (valor !== null) extraItens.push({ label, valor }); };

    addExtra('Coligação', v(cand?.coligacao));
    addExtra('Federação', v(cand?.federacao));
    addExtra('Idade', (cand?.idade != null && !isNaN(cand.idade)) ? `${cand.idade} anos` : null);
    addExtra('Instrução', v(cand?.instrucao) || v(fallback?.escolaridade));
    addExtra('Ocupação', v(cand?.ocupacao) || v(fallback?.ocupacao));
    addExtra('Nome social', v(cand?.nomeSocial));

    if (extraItens.length > 0) {
        html += '<details class="cand-dados-extra"><summary>Mais informações</summary><dl class="cand-dados-dl">';
        extraItens.forEach(({ label, valor }) => {
            html += `<div class="cand-dados-item"><dt>${escaparHTML(label)}</dt><dd>${escaparHTML(valor)}</dd></div>`;
        });
        html += '</dl></details>';
    }

    // Disclaimer de fonte — apenas se houver conteúdo para não poluir mensagem vazia
    if (html) html += criarDisclaimerFonte('candidato');
    el.innerHTML = html || '<p class="texto-mutado">Dados não disponíveis.</p>';
}

// ── Card: Patrimônio Declarado (formato lista) ─
function renderizarPatrimonio(patrimonio) {
    const contPatr = document.getElementById('conteudoPatrimonio');
    if (!contPatr) return;

    const fmt = fmtMoeda;

    const bens = patrimonio?.bens || [];
    let totalBens = patrimonio?.total != null ? Number(patrimonio.total) : 0;

    if (totalBens === 0 && bens.length > 0) {
        bens.forEach(bem => {
            const valorNum = parseFloat(String(bem.valor).replace(',', '.'));
            if (!isNaN(valorNum)) totalBens += valorNum;
        });
    }

    if (bens.length > 0 || totalBens > 0) {
        const bensOrdenados = [...bens].sort((a, b) => {
            const valA = parseFloat(String(a.valor).replace(',', '.')) || 0;
            const valB = parseFloat(String(b.valor).replace(',', '.')) || 0;
            return valB - valA;
        });

        const mostrarTop = 5;
        const bensIniciais = bensOrdenados.slice(0, mostrarTop);
        const bensOcultos = bensOrdenados.slice(mostrarTop);

        let html = `<p class="cand-patr-quantidade">${bens.length} bem(ns) declarado(s)</p>`;
        html += '<div class="cand-patr-itens">';

        const renderItem = (bem) => `
            <div class="cand-patr-item">
                <div class="cand-patr-item-desc">
                    <span class="cand-patr-tipo">${escaparHTML(bem.tipo || 'Bem')}</span>
                    <span class="cand-patr-desc">${escaparHTML(bem.descricao || '-')}</span>
                </div>
                <span class="cand-patr-valor">${fmt(bem.valor)}</span>
            </div>
        `;

        bensIniciais.forEach(bem => { html += renderItem(bem); });

        if (bensOcultos.length > 0) {
            html += `<div id="bensOcultos" class="hidden">`;
            bensOcultos.forEach(bem => { html += renderItem(bem); });
            html += `</div>`;
            html += `<button id="btnVerMaisBens" class="btn-secundario btn-sm">Ver todos os ${bens.length} bens</button>`;
        }

        html += `</div>`; // fecha cand-patr-itens

        // Total em destaque
        html += `<div class="cand-patr-total"><span>Valor total declarado</span><strong>${fmt(totalBens)}</strong></div>`;
        // Disclaimer de fonte de dados patrimoniais
        html += criarDisclaimerFonte('patrimonio');

        contPatr.innerHTML = html;

        // Listener do botão ver mais
        if (bensOcultos.length > 0) {
            setTimeout(() => {
                const btn = document.getElementById('btnVerMaisBens');
                const divOculta = document.getElementById('bensOcultos');
                if (btn && divOculta) {
                    btn.addEventListener('click', () => {
                        const taEscondido = divOculta.classList.contains('hidden');
                        if (taEscondido) {
                            divOculta.classList.remove('hidden');
                            btn.textContent = 'Ocultar bens menores';
                        } else {
                            divOculta.classList.add('hidden');
                            btn.textContent = `Ver todos os ${bens.length} bens`;
                        }
                    });
                }
            }, 0);
        }
    } else {
        contPatr.innerHTML = '<p class="texto-mutado">Nenhum bem declarado.</p>';
    }
}

// ── Card: Documentos e Situação Jurídica ───
function renderizarDocumentosJuridicos(cand, docs, financeiro, juridico) {
    const el = document.getElementById('conteudoDocumentosJuridicos');
    if (!el) return;

    const v = normalizarValor;
    const fmt = fmtMoeda;

    let html = '';
    let temConteudo = false;

    // 1. Situação do julgamento — classificação em 3 níveis (evita presunção de culpa)
    const julgamento = v(cand?.statusJulgamento);
    if (julgamento) {
        temConteudo = true;
        const cls = classificarStatusJuridico(julgamento);
        html += `<div class="cand-juridico-item ${cls}">
            <span class="cand-juridico-label">Situação do julgamento</span>
            <span class="cand-juridico-status">${escaparHTML(julgamento)}</span>
        </div>`;
    }

    // 2. Candidatura à reeleição
    const reeleicao = simNao(cand?.tentandoReeleicao);
    if (reeleicao) {
        temConteudo = true;
        html += `<div class="cand-juridico-item">
            <span class="cand-juridico-label">Candidatura à reeleição</span>
            <span class="cand-juridico-status">${escaparHTML(reeleicao)}</span>
        </div>`;
    }

    // 3. Situação da candidatura na urna
    const situacaoUrna = v(cand?.situacaoUrna);
    if (situacaoUrna) {
        temConteudo = true;
        html += `<div class="cand-juridico-item">
            <span class="cand-juridico-label">Situação na urna</span>
            <span class="cand-juridico-status">${escaparHTML(situacaoUrna)}</span>
        </div>`;
    }

    // 4. Número do processo
    const nrProcesso = v(cand?.nrProcesso);
    if (nrProcesso) {
        temConteudo = true;
        html += `<div class="cand-juridico-item">
            <span class="cand-juridico-label">N.º do processo</span>
            <span class="cand-juridico-status">${escaparHTML(nrProcesso)}</span>
        </div>`;
    }

    // 5. Situação do diploma
    const situacaoDiploma = v(cand?.situacaoDiploma);
    if (situacaoDiploma) {
        temConteudo = true;
        html += `<div class="cand-juridico-item">
            <span class="cand-juridico-label">Situação do diploma</span>
            <span class="cand-juridico-status">${escaparHTML(situacaoDiploma)}</span>
        </div>`;
    }

    // 6. Situação eleitoral relacionada
    const situacaoEleitoral = v(cand?.situacaoEleitoral);
    if (situacaoEleitoral) {
        temConteudo = true;
        html += `<div class="cand-juridico-item">
            <span class="cand-juridico-label">Situação eleitoral relacionada</span>
            <span class="cand-juridico-status">${escaparHTML(situacaoEleitoral)}</span>
        </div>`;
    }

    // 7. Situação da cassação — classificação em 3 níveis
    const situacaoCassacao = v(cand?.situacaoCassacao);
    if (situacaoCassacao) {
        temConteudo = true;
        const cls = classificarStatusJuridico(situacaoCassacao);
        html += `<div class="cand-juridico-item ${cls}">
            <span class="cand-juridico-label">Situação da cassação</span>
            <span class="cand-juridico-status">${escaparHTML(situacaoCassacao)}</span>
        </div>`;
    }

    // 8. Motivo da cassação (registros oficiais)
    const motivosCassacao = juridico?.motivoCassacao || [];
    if (motivosCassacao.length > 0) {
        temConteudo = true;
        html += `<div class="cand-juridico-subsecao">
            <h4 class="cand-juridico-subtitulo">Registro(s) de cassação</h4>
            <div class="disclaimer-juridico-alerta">⚠️ Registros constantes nas bases públicas do TSE no momento da coleta. <strong>Não representam condenações definitivas nem implicam culpa</strong> (CF/88, art. 5.º, LVII — presunção de inocência).</div>
            <ul class="cand-docs-lista">`;
        motivosCassacao.forEach(m => {
            html += `<li>${escaparHTML(m)}</li>`;
        });
        html += `</ul></div>`;
    }

    // 9. Prestação de contas (Financeiro)
    if (financeiro) {
        temConteudo = true;
        html += `<div class="cand-juridico-subsecao">
            <h4 class="cand-juridico-subtitulo">Prestação de contas</h4>`;

        const totalC = financeiro.total_contratado || 0;
        const totalP = financeiro.total_pago || 0;

        // Situação da prestação de contas (do TSE)
        const sitPrestacao = v(cand?.situacaoPrestacaoContas);
        if (sitPrestacao) {
            html += `<div class="cand-juridico-item">
                <span class="cand-juridico-label">Situação da prestação</span>
                <span class="cand-juridico-status">${escaparHTML(sitPrestacao)}</span>
            </div>`;
        }

        // Usa percentual_pago do JSON se disponível, senão calcula
        let percHTML = '';
        const percPago = financeiro.percentual_pago;
        if (percPago != null) {
            percHTML = `<span class="badge-percentual">${percPago}% pago</span>`;
        } else if (totalC > 0) {
            const perc = ((totalP / totalC) * 100).toFixed(1);
            percHTML = `<span class="badge-percentual">${perc}% pago</span>`;
        }

        html += `<div class="cand-fin-item">
            <span>Total Arrecadado</span>
            <strong>${fmt(financeiro.total_arrecadado || 0)}</strong>
        </div>`;
        html += `<div class="cand-fin-item">
            <span>Total Contratado</span>
            <strong>${fmt(totalC)}</strong>
        </div>`;
        html += `<div class="cand-fin-item">
            <span>Total Pago</span>
            <strong>${totalP == null || isNaN(totalP)
                ? '<span class="texto-mutado" style="font-weight:400;font-size:0.88em;">Dados indisponíveis</span>'
                : `${fmt(totalP)} ${percHTML}`}</strong>
        </div>`;
        // Quantidades — exibe "Não registrado" quando o valor for zero ou ausente
        // para evitar interpretações equivocadas de "0 receitas"
        const fmtQtd = (v) => (v != null && v !== 0) ? v : '<span class="texto-mutado" style="font-style:italic;font-size:0.95em;">Não registrado</span>';
        html += `<div class="cand-fin-quantidades texto-mutado">
            Receitas: ${fmtQtd(financeiro.quantidade_receitas)} &nbsp;|
            Despesas contratadas: ${fmtQtd(financeiro.quantidade_despesas_contratadas)} &nbsp;|
            Despesas pagas: ${fmtQtd(financeiro.quantidade_despesas_pagas)}
        </div>`;
        // Disclaimer de fonte — dados financeiros podem estar em retificação pelo TSE
        html += criarDisclaimerFonte('financeiro');
        html += `</div>`;
    }

    // 4. Propostas de governo
    if (docs?.propostas && docs.propostas.length > 0) {
        temConteudo = true;
        html += `<div class="cand-juridico-subsecao">
            <h4 class="cand-juridico-subtitulo">Proposta(s) de governo</h4>
            <ul class="cand-docs-lista">`;
        docs.propostas.forEach(p => {
            const nome = nomeLegivelDocumento(p.nome || p.caminho);
            html += `<li>${escaparHTML(nome)}</li>`;
        });
        html += `</ul></div>`;
    }

    // 5. Certidões — exibe apenas a contagem, sem listar nomes de arquivos
    if (docs?.certidoes && docs.certidoes.length > 0) {
        temConteudo = true;
        const qtd = docs.certidoes.length;
        html += `<div class="cand-juridico-subsecao">
            <h4 class="cand-juridico-subtitulo">Certidões disponíveis</h4>
            <div class="disclaimer-juridico-alerta">⚠️ ${qtd} certid${qtd > 1 ? 'ões' : 'ão'} de registro público disponível${qtd > 1 ? 'is' : ''} na base do TSE. A existência de uma certidão <strong>não implica julgamento, condenação ou irregularidade</strong>.</div>
            </div>`;
    }

    // Disclaimer de fonte jurídica (situação de candidatura, julgamento, cassação)
    if (temConteudo) html += criarDisclaimerFonte('juridico');
    // Link para reportar erro ao final do card
    el.innerHTML = html || '<p class="texto-mutado">Nenhum registro disponível.</p>';
}

// Helper: extrai nome legível do documento
function nomeLegivelDocumento(nomeArquivo) {
    if (!nomeArquivo) return 'Documento';
    let nome = String(nomeArquivo);
    nome = nome.replace(/\.pdf$/i, '');
    nome = nome.replace(/^[a-f0-9]{8,}_/i, '');
    nome = nome.replace(/^[A-Z0-9]{6,}_/i, '');
    nome = nome.replace(/[_\-]+/g, ' ');
    nome = nome.replace(/\b(\w)/g, (c) => c.toUpperCase());
    return nome.trim() || 'Documento';
}

async function abrirFicha(id, uf) {
    // Lazy Load: Baixa o JSON gigante apenas se ainda não tiver baixado
    if (!dadosCandidatos) {
        msgResultados.innerHTML = icon('ampulheta') + ' Baixando dossiês completos pela primeira vez...';
        try {
            const response = await fetch('dados_candidatos.json');
            dadosCandidatos = await response.json();
            msgResultados.innerText = "";
            // Lê a data de geração do JSON e atualiza a interface
            if (dadosCandidatos._meta?.geradoEm) {
                try {
                    const d = new Date(dadosCandidatos._meta.geradoEm);
                    dataGeracaoJson = d.toLocaleDateString('pt-BR');
                } catch (_) { /* mantém o fallback */ }
                atualizarDatasInterface();
            }
        } catch (error) {
            msgResultados.innerHTML = icon('cancel') + ' Erro ao carregar dados detalhados.';
            return;
        }
    }

    // Busca a chave no formato UF_SQ_CANDIDATO (único formato usado pelo índice)
    const chaveComUF = `${uf}_${id}`;
    const dados = dadosCandidatos[chaveComUF];

    if (!dados) {
        console.error("ID procurado:", id, "UF:", uf);
        console.error("Amostra das chaves no JSON:", Object.keys(dadosCandidatos).slice(0, 5));
        alert("Erro: Dossiê não encontrado. Aperte F12 e veja o Console para mais detalhes.");
        return;
    }

    candidatoAtual = dados;

    // 4.0. Carrega dados extras (foto, documentos, financeiro) via API privada
    const chaveCompleta = `${uf}_${id}`;
    dadosExtrasAtual = null;
    try {
        const resExtra = await fetch(`/api/candidato?id=${encodeURIComponent(chaveCompleta)}`);
        if (resExtra.ok) dadosExtrasAtual = await resExtra.json();
    } catch (e) {
        console.warn('Dados extras não carregados:', e);
    }

    // 4.0a. Foto — Seção 01
    const imgFoto = document.getElementById('candFoto');
    const caminhoFoto = dadosExtrasAtual?.foto?.arquivo;
    if (caminhoFoto) {
        imgFoto.src = caminhoFoto.startsWith('/') ? caminhoFoto : '/' + caminhoFoto;
    } else {
        // Placeholder SVG 120x120 quando não há foto disponível
        imgFoto.src = 'data:image/svg+xml,%3Csvg xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22 viewBox%3D%220 0 120 120%22%3E%3Crect width%3D%22120%22 height%3D%22120%22 fill%3D%22%23333%22%2F%3E%3Ccircle cx%3D%2260%22 cy%3D%2245%22 r%3D%2226%22 fill%3D%22%23666%22%2F%3E%3Cellipse cx%3D%2260%22 cy%3D%22108%22 rx%3D%2240%22 ry%3D%2228%22 fill%3D%22%23666%22%2F%3E%3C%2Fsvg%3E';
    }

    // 4.1. Header do Dossiê (SQ_CANDIDATO)
    const cand = dadosExtrasAtual?.candidato;          // fonte primária: data/candidatos.json
    const perfFallback = dados.perfil || {};            // fallback: dados_candidatos.json
    const idExibido = cand?.id || dados.id || id;
    document.getElementById('candIdHeader').innerText = idExibido;

    // Card: Dados do Candidato
    renderizarDadosCandidato(cand, perfFallback);

    // Card: Patrimônio Declarado
    renderizarPatrimonio(dadosExtrasAtual?.patrimonio);

    // Card: Documentos e Situação Jurídica
    renderizarDocumentosJuridicos(cand, dadosExtrasAtual?.documentos, dadosExtrasAtual?.financeiro, dadosExtrasAtual?.juridico);

    // 4.3. Resetando a IA e verificando cache
    resultadoIA.classList.add('hidden');
    resultadoIA.innerHTML = '';
    btnGerarResumo.innerHTML = iconFixed('star', 'p') + ' Verificando...';
    btnGerarResumo.disabled = true;

    // Se o candidato não tiver PDF de proposta, desativamos o botão
    const temProposta = dadosExtrasAtual?.documentos?.propostas && dadosExtrasAtual.documentos.propostas.length > 0;
    if (!temProposta) {
        btnGerarResumo.disabled = true;
        btnGerarResumo.classList.add('texto-mutado');
        btnGerarResumo.innerText = 'Sem proposta anexada';
    } else {
        // Verifica se já existe resumo em cache para este candidato
        verificarCacheResumo(chaveCompleta);
    }

    // 4.5. Botão de reportar erro ao final do conteúdo da ficha
    // Só renderiza quando URL_FORMULARIO_ERRO estiver preenchida — nunca exibe link vazio ou quebrado
    const fichaConteudo = document.getElementById('conteudoFicha');
    const reportarErroExistente = fichaConteudo.querySelector('.dossier-reportar-erro');
    if (!reportarErroExistente && URL_FORMULARIO_ERRO) {
        const reportarDiv = document.createElement('div');
        reportarDiv.className = 'dossier-reportar-erro';
        reportarDiv.innerHTML = `
            <span>💬 Encontrou alguma inconsistência ou dado incorreto neste candidato?</span>
            <a href="${URL_FORMULARIO_ERRO}" target="_blank" rel="noopener noreferrer" class="btn-reportar-erro">
                <span class="icon-img"><img class="img-b" src="icons/warning_b.svg" alt=""><img class="img-p" src="icons/warning_p.svg" alt=""></span>
                Reportar erro
            </a>
        `;
        fichaConteudo.appendChild(reportarDiv);
    }

    // 4.6. Transição de Tela
    document.querySelector('.barra-pesquisa').classList.add('hidden');
    areaResultados.classList.add('hidden');
    areaFicha.classList.remove('hidden');
}

// Botão de Voltar
btnVoltar.addEventListener('click', () => {
    areaFicha.classList.add('hidden');
    document.querySelector('.barra-pesquisa').classList.remove('hidden');
    areaResultados.classList.remove('hidden');
});

// ==========================================
// 5. VERIFICAÇÃO DE CACHE (endpoint leve)
// ==========================================
async function verificarCacheResumo(idCandidato) {
    try {
        const res = await fetch(`/api/resumo?id_candidato=${encodeURIComponent(idCandidato)}`);
        if (!res.ok) {
            configurarBotaoResumo(false);
            return;
        }
        const data = await res.json();
        configurarBotaoResumo(data.cached === true);
    } catch (error) {
        console.error('Erro ao verificar cache de resumo:', error);
        configurarBotaoResumo(false);
    }
}

function configurarBotaoResumo(cached) {
    btnGerarResumo.disabled = false;
    btnGerarResumo.classList.remove('texto-mutado');
    if (cached) {
        btnGerarResumo.innerHTML = iconFixed('doc', 'p') + ' Mostrar resumo';
        btnGerarResumo.dataset.cached = 'true';
    } else {
        btnGerarResumo.innerHTML = iconFixed('star', 'p') + ' Gerar Resumo com IA';
        btnGerarResumo.dataset.cached = 'false';
    }
}

// ==========================================
// 6. EXIBIÇÃO DE RESUMO (compartilhada)
// ==========================================
function exibirResumo(textoResumo) {
    resultadoIA.classList.remove('hidden');
    resultadoIA.innerHTML = '';

    // Renderiza o resumo de forma segura: textContent para evitar XSS, <br> explícitos para quebras de linha
    const linhas = textoResumo.split('\n');
    linhas.forEach((linha, i) => {
        resultadoIA.appendChild(document.createTextNode(linha));
        if (i < linhas.length - 1) {
            resultadoIA.appendChild(document.createElement('br'));
        }
    });

    // Disclaimer de IA (risco: IA pode interpretar errado o texto)
    const disclaimer = document.createElement('p');
    disclaimer.className = 'disclaimer-ia';
    disclaimer.textContent = DISCLAIMER_IA;
    resultadoIA.appendChild(disclaimer);

    // Disclaimer de fonte (risco: dado pode estar desatualizado em relação ao TSE)
    // Adicionado ABAIXO do aviso de IA — são riscos distintos, ambos devem ser visíveis
    const disclaimerFonte = document.createElement('div');
    disclaimerFonte.innerHTML = criarDisclaimerFonte('candidato');
    resultadoIA.appendChild(disclaimerFonte.firstElementChild);
}

// Exibe uma mensagem informativa neutra (não é erro)
function exibirInfoNeutra(mensagem) {
    resultadoIA.classList.remove('hidden');
    resultadoIA.innerHTML = '';
    const span = document.createElement('span');
    span.className = 'texto-info-neutra';
    span.textContent = mensagem;
    resultadoIA.appendChild(span);
}
// ==========================================
// 7. COMUNICAÇÃO COM A VERCEL (Motor Gemini)
// ==========================================
btnGerarResumo.addEventListener('click', async () => {
    if (!candidatoAtual) return;

    // Se já existe em cache, busca via GET e exibe sem chamar Gemini
    if (btnGerarResumo.dataset.cached === 'true') {
        btnGerarResumo.disabled = true;
        btnGerarResumo.innerText = 'Carregando...';
        loadingIA.classList.remove('hidden');
        resultadoIA.classList.add('hidden');

        try {
            const res = await fetch('/api/resumo', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id_candidato: candidatoAtual.uf + '_' + candidatoAtual.id }),
            });

            loadingIA.classList.add('hidden');

            // Verifica se a resposta é válida antes de tentar parsear JSON
            const contentType = res.headers.get('content-type') || '';
            if (!contentType.includes('application/json')) {
                const text = await res.text();
                console.error('Resposta não-JSON:', res.status, text.substring(0, 200));
                mostrarErroIA(`Erro ${res.status}: O servidor retornou uma resposta inesperada.`);
                return;
            }

            const data = await res.json();

            if (res.ok && data.resumo) {
                exibirResumo(data.resumo);
            } else if (res.ok && data.bloqueado) {
                exibirInfoNeutra(data.mensagem);
                btnGerarResumo.disabled = true;
                btnGerarResumo.classList.add('texto-mutado');
            } else if (res.ok && data.semProposta) {
                exibirInfoNeutra(data.mensagem);
                btnGerarResumo.disabled = true;
                btnGerarResumo.classList.add('texto-mutado');
            } else {
                mostrarErroIA(`Erro: ${data.erro || 'Falha desconhecida'}`);
            }
        } catch (e) {
            console.error(e);
            loadingIA.classList.add('hidden');
            mostrarErroIA('Erro de comunicação com o servidor. Verifique o console (F12).');
        }

        btnGerarResumo.disabled = false;
        btnGerarResumo.innerHTML = iconFixed('doc', 'p') + ' Mostrar resumo';
        return;
    }

    // Cache não existe — chama o Gemini normalmente
    btnGerarResumo.disabled = true;
    btnGerarResumo.innerText = 'Processando...';
    loadingIA.classList.remove('hidden');
    resultadoIA.classList.add('hidden');

    try {
        // Envia o ID do candidato no corpo da requisição via POST
        const res = await fetch('/api/resumo', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id_candidato: candidatoAtual.uf + '_' + candidatoAtual.id }),
        });

        loadingIA.classList.add('hidden');

        // Verifica se a resposta é válida antes de tentar parsear JSON
        const contentType = res.headers.get('content-type') || '';
        if (!contentType.includes('application/json')) {
            const text = await res.text();
            console.error('Resposta não-JSON:', res.status, text.substring(0, 200));
            mostrarErroIA(`Erro ${res.status}: O servidor retornou uma resposta inesperada. Verifique se as variáveis de ambiente estão configuradas.`);
            return;
        }

        const data = await res.json();

        if (res.ok && data.resumo) {
            exibirResumo(data.resumo);
            // Após gerar com sucesso, atualiza o botão para "Mostrar resumo"
            btnGerarResumo.innerHTML = iconFixed('doc', 'p') + ' Mostrar resumo';
            btnGerarResumo.dataset.cached = 'true';
        } else if (res.ok && data.bloqueado) {
            exibirInfoNeutra(data.mensagem);
            btnGerarResumo.disabled = true;
            btnGerarResumo.classList.add('texto-mutado');
            btnGerarResumo.innerText = 'Resumo bloqueado';
        } else if (res.ok && data.semProposta) {
            exibirInfoNeutra(data.mensagem);
            btnGerarResumo.disabled = true;
            btnGerarResumo.classList.add('texto-mutado');
            btnGerarResumo.innerText = 'Sem proposta de governo';
        } else {
            mostrarErroIA(`Erro: ${data.erro || 'Falha desconhecida'}`);
        }

    } catch (e) {
        console.error(e);
        loadingIA.classList.add('hidden');
        mostrarErroIA('Erro de comunicação com o servidor. Verifique o console (F12).');
    }

    btnGerarResumo.disabled = false;
});

function mostrarErroIA(mensagem) {
    resultadoIA.classList.remove('hidden');
    resultadoIA.innerHTML = '';
    const span = document.createElement('span');
    span.className = 'texto-erro';
    span.textContent = mensagem;
    resultadoIA.appendChild(span);
}

// Dá o pontapé inicial!
carregarListaBusca();
