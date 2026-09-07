// ==========================================
// 1. MAPEAMENTO DO DOM (Elementos da Tela)
// ==========================================
const inputNome = document.getElementById('inputNome');
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

// Disclaimer de IA exibido junto a todo resumo
const DISCLAIMER_IA = 'Resumo gerado por Inteligência Artificial a partir do texto oficial da proposta de governo — pode conter imprecisões.';

// ==========================================
// 2. ESTADO DA APLICAÇÃO (Memória)
// ==========================================
let listaBusca = [];
let dadosCandidatos = null; // Só será carregado quando clicarem em Consultar
let candidatoAtual = null;

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
        msgResultados.innerText = "❌ Erro ao carregar o banco de dados principal.";
        console.error(error);
    }
}

// ==========================================
// 3. LÓGICA DE PESQUISA E FILTRO
// ==========================================
btnPesquisar.addEventListener('click', () => {
    const termo = normalizarTexto(inputNome.value);
    const uf = selectUF.value;
    const cargo = selectCargo.value;

    if (!termo && !uf && !cargo) {
        msgResultados.innerText = "⚠️ Preencha pelo menos um campo (Nome, UF ou Cargo) para pesquisar.";
        listaCandidatos.innerHTML = '';
        return;
    }

    const filtrados = listaBusca.filter(cand => {
        // Usa o nomeBusca que já limpamos no Python
        const matchNome = !termo || (cand.nomeBusca && cand.nomeBusca.includes(termo));
        const matchUF = !uf || cand.uf === uf;
        const matchCargo = !cargo || cand.cargo === cargo;
        return matchNome && matchUF && matchCargo;
    });

    // Ordena alfabeticamente
    filtrados.sort((a, b) => (a.nome || "").localeCompare(b.nome || ""));

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
        exibidos = resultados.slice(0, 50); // Trava de desempenho igual a do Colab
        aviso = " (⚠️ Exibindo apenas os 50 primeiros)";
    }

    msgResultados.innerText = `🔎 ${resultados.length} candidato(s) encontrado(s).${aviso}`;

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
async function abrirFicha(id, uf) {
    // Lazy Load: Baixa o JSON gigante apenas se ainda não tiver baixado
    if (!dadosCandidatos) {
        msgResultados.innerText = "⏳ Baixando dossiês completos pela primeira vez...";
        try {
            const response = await fetch('dados_candidatos.json');
            dadosCandidatos = await response.json();
            msgResultados.innerText = "";
        } catch (error) {
            msgResultados.innerText = "❌ Erro ao carregar dados detalhados.";
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

    // 4.1. Preenchendo o Cabeçalho e Perfil
    const nomeOficial = dados.perfil?.nome || "Candidato";
    const nomeUrna = dados.perfil?.nomeUrna || "Não informado";

    document.getElementById('candNome').innerText = `${nomeOficial} (Urna: ${nomeUrna})`;
    document.getElementById('candCargo').innerText = dados.perfil?.cargo || dados.cargo || "Não informado";
    document.getElementById('candPartido').innerText = dados.perfil?.partido || "Não informado";
    document.getElementById('candUF').innerText = dados.uf || uf || "Não informado";
    document.getElementById('candID').innerText = dados.id || id || "Não informado";

    document.getElementById('candOcupacao').innerText = dados.perfil?.ocupacao || "Não informado";
    document.getElementById('candEscolaridade').innerText = dados.perfil?.escolaridade || "Não informado";
    document.getElementById('candGenero').innerText = dados.perfil?.genero || "Não informado";
    document.getElementById('candRaca').innerText = dados.perfil?.raca || "Não informado";

    // 4.2. Preenchendo o Patrimônio
    let totalBens = 0;
    const tabelaCorpo = document.getElementById('tabelaBensCorpo');
    tabelaCorpo.innerHTML = '';

    if (dados.bens && dados.bens.length > 0) {
        dados.bens.forEach(bem => {
            const valorNum = parseFloat(String(bem.valor).replace(',', '.'));
            if (!isNaN(valorNum)) totalBens += valorNum;

            const tr = document.createElement('tr');
            ['tipo', 'descricao', 'valor'].forEach(campo => {
                const td = document.createElement('td');
                td.textContent = campo === 'valor' ? `R$ ${bem.valor}` : bem[campo];
                tr.appendChild(td);
            });
            tabelaCorpo.appendChild(tr);
        });
    } else {
        tabelaCorpo.innerHTML = `<tr><td colspan="3" class="texto-mutado">Nenhum bem declarado.</td></tr>`;
    }

    // Formata o total para R$ brasileiro
    document.getElementById('candTotalBens').innerText = totalBens.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

    // 4.3. Resetando a IA e verificando cache
    resultadoIA.classList.add('hidden');
    resultadoIA.innerHTML = '';
    btnGerarResumo.innerText = '✨ Verificando...';
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

    // 4.4. Transição de Tela
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
        btnGerarResumo.innerText = '📄 Mostrar resumo';
        btnGerarResumo.dataset.cached = 'true';
    } else {
        btnGerarResumo.innerText = '✨ Gerar Resumo com IA';
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
            } else {
                mostrarErroIA(`Erro: ${data.erro || 'Falha desconhecida'}`);
            }
        } catch (e) {
            console.error(e);
            loadingIA.classList.add('hidden');
            mostrarErroIA('Erro de comunicação com o servidor. Verifique o console (F12).');
        }

        btnGerarResumo.disabled = false;
        btnGerarResumo.innerText = '📄 Mostrar resumo';
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
            btnGerarResumo.innerText = '📄 Mostrar resumo';
            btnGerarResumo.dataset.cached = 'true';
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
    span.style.color = '#ff4c4c';
    span.textContent = mensagem;
    resultadoIA.appendChild(span);
}

// Dá o pontapé inicial!
carregarListaBusca();
