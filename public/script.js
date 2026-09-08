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
const DISCLAIMER_IA = 'Resumo gerado por Inteligência Artificial a partir do texto oficial da proposta de governo — pode conter imprecisões.';

// ==========================================
// 2. ESTADO DA APLICAÇÃO (Memória)
// ==========================================
let listaBusca = [];
let dadosCandidatos = null; // Só será carregado quando clicarem em Consultar
let candidatoAtual = null;
let dadosExtrasAtual = null; // Dados de api/candidato.js (foto, documentos, financeiro)

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
        span.textContent = `${cand.cargo || 'Cargo Indefinido'} • ${cand.uf} • ID: ${cand.id}`;
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
    const nomeUrna     = v(cand?.nomeUrna)     || v(fallback?.nomeUrna);
    const numero       = v(cand?.numeroUrna);
    const cargo        = v(cand?.cargo)        || v(fallback?.cargo);
    const partido      = v(cand?.partido)      || v(fallback?.partido);
    const ufVal        = v(cand?.uf);
    const situacao     = v(cand?.situacao);

    let html = '';

    // Nome completo destacado
    if (nomeCompleto) {
        html += `<p class="cand-nome-completo">${nomeCompleto}</p>`;
    }
    if (nomeUrna && nomeUrna !== nomeCompleto) {
        html += `<p class="cand-nome-urna">Urna: <strong>${nomeUrna}</strong></p>`;
    }

    // Grid de campos
    const itens = [];
    const add = (label, valor) => { if (valor !== null) itens.push({ label, valor }); };

    add('N.º Candidatura', numero);
    add('Partido',         partido);
    add('Cargo',           cargo);
    add('UF',              ufVal ? formatarUF(ufVal) : null);
    add('Situação da candidatura', situacao);

    if (itens.length > 0) {
        html += '<dl class="cand-dados-dl">';
        itens.forEach(({ label, valor }) => {
            html += `<div class="cand-dados-item"><dt>${label}</dt><dd>${valor}</dd></div>`;
        });
        html += '</dl>';
    }

    // Campos adicionais de perfil que não estão no card principal
    // Mas que são relevantes: coligação, gênero, idade, instrução, ocupação, raça
    const extraItens = [];
    const addExtra = (label, valor) => { if (valor !== null) extraItens.push({ label, valor }); };

    addExtra('Coligação',   v(cand?.coligacao));
    addExtra('Gênero',      v(cand?.genero)    || v(fallback?.genero));
    addExtra('Idade',       (cand?.idade != null && !isNaN(cand.idade)) ? `${cand.idade} anos` : null);
    addExtra('Instrução',   v(cand?.instrucao) || v(fallback?.escolaridade));
    addExtra('Ocupação',    v(cand?.ocupacao)  || v(fallback?.ocupacao));
    addExtra('Cor / Raça',  v(cand?.corRaca)   || v(fallback?.raca));

    if (extraItens.length > 0) {
        html += '<details class="cand-dados-extra"><summary>Mais informações</summary><dl class="cand-dados-dl">';
        extraItens.forEach(({ label, valor }) => {
            html += `<div class="cand-dados-item"><dt>${label}</dt><dd>${valor}</dd></div>`;
        });
        html += '</dl></details>';
    }

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
                    <span class="cand-patr-tipo">${bem.tipo || 'Bem'}</span>
                    <span class="cand-patr-desc">${bem.descricao || '-'}</span>
                </div>
                <span class="cand-patr-valor">${bem.valor || 'R$ 0,00'}</span>
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
function renderizarDocumentosJuridicos(cand, docs, financeiro) {
    const el = document.getElementById('conteudoDocumentosJuridicos');
    if (!el) return;

    const v = normalizarValor;
    const fmt = fmtMoeda;

    let html = '';
    let temConteudo = false;

    // 1. Situação do julgamento
    const julgamento = v(cand?.statusJulgamento);
    if (julgamento) {
        temConteudo = true;
        const cls = julgamento === 'DEFERIDO' ? 'status-positivo' : 'status-atencao';
        html += `<div class="cand-juridico-item ${cls}">
            <span class="cand-juridico-label">Situação do julgamento</span>
            <span class="cand-juridico-status">${julgamento}</span>
        </div>`;
    }

    // 2. Candidatura à reeleição
    const reeleicao = simNao(cand?.tentandoReeleicao);
    if (reeleicao) {
        temConteudo = true;
        html += `<div class="cand-juridico-item">
            <span class="cand-juridico-label">Candidatura à reeleição</span>
            <span class="cand-juridico-status">${reeleicao}</span>
        </div>`;
    }

    // 3. Prestação de contas (Financeiro)
    if (financeiro) {
        temConteudo = true;
        html += `<div class="cand-juridico-subsecao">
            <h4 class="cand-juridico-subtitulo">Prestação de contas</h4>`;

        const totalC = financeiro.total_contratado || 0;
        const totalP = financeiro.total_pago || 0;

        let percHTML = '';
        if (totalC > 0) {
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
            <strong>${fmt(totalP)} ${percHTML}</strong>
        </div>`;
        html += `<div class="cand-fin-quantidades texto-mutado">
            Receitas: ${financeiro.quantidade_receitas || 0} |
            Despesas contrato: ${financeiro.quantidade_despesas_contratadas || 0} |
            Pagas: ${financeiro.quantidade_despesas_pagas || 0}
        </div>`;
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
            html += `<li>${nome}</li>`;
        });
        html += `</ul></div>`;
    }

    // 5. Certidões
    if (docs?.certidoes && docs.certidoes.length > 0) {
        temConteudo = true;
        html += `<div class="cand-juridico-subsecao">
            <h4 class="cand-juridico-subtitulo">Certidões</h4>
            <p class="texto-mutado" style="margin: 0 0 8px; font-size: 0.78em;">(registros oficiais disponíveis — não implica julgamento)</p>
            <ul class="cand-docs-lista">`;
        docs.certidoes.forEach(c => {
            const nome = nomeLegivelDocumento(c.nome || c.caminho);
            html += `<li>${nome}</li>`;
        });
        html += `</ul></div>`;
    }

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
        } catch (error) {
            msgResultados.innerHTML = icon('cancel') + ' Erro ao carregar dados detalhados.';
            return;
        }
    }

    // Tenta buscar a chave nos dois formatos possíveis
    const chaveComUF = `${uf}_${id}`;
    const chaveSemUF = id;
    const dados = dadosCandidatos[chaveComUF] || dadosCandidatos[chaveSemUF];

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
        imgFoto.src = caminhoFoto;
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
    renderizarDocumentosJuridicos(cand, dadosExtrasAtual?.documentos, dadosExtrasAtual?.financeiro);

    // 4.3. Resetando a IA e verificando cache
    resultadoIA.classList.add('hidden');
    resultadoIA.innerHTML = '';
    btnGerarResumo.innerHTML = iconFixed('star', 'p') + ' Verificando...';
    btnGerarResumo.disabled = true;

    // Se o candidato não tiver PDF de proposta, desativamos o botão
    const temProposta = dados.documentos && dados.documentos.propostas && dados.documentos.propostas.length > 0;
    if (!temProposta) {
        btnGerarResumo.disabled = true;
        btnGerarResumo.classList.add('texto-mutado');
        btnGerarResumo.innerText = 'Sem proposta anexada';
    } else {
        // Verifica se já existe resumo em cache para este candidato
        verificarCacheResumo(dados.id);
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

    // Disclaimer de IA
    const disclaimer = document.createElement('p');
    disclaimer.className = 'disclaimer-ia';
    disclaimer.textContent = DISCLAIMER_IA;
    resultadoIA.appendChild(disclaimer);
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
                body: JSON.stringify({ id_candidato: candidatoAtual.id }),
            });

            loadingIA.classList.add('hidden');

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
            body: JSON.stringify({ id_candidato: candidatoAtual.id }),
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
