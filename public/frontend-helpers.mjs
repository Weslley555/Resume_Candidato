export const chaveCanonica = value => typeof value === 'string' && /^\d{4}_\d+_[A-Z]{2}_\d+$/.test(value);
export const hashValido = value => typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value);
export const identificadorAPI = value => chaveCanonica(value) || (typeof value === 'string' && /^[A-Z]{2}_\d+$/.test(value));
export const normalizarTexto = value => String(value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();

export function inteiroExato(value) {
    if (typeof value === 'bigint') return value;
    if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value);
    if (typeof value === 'string' && /^-?\d+$/.test(value)) return BigInt(value);
    return null;
}
export function fmtCentavos(value) {
    const n = inteiroExato(value);
    if (n === null) return null;
    const abs = n < 0n ? -n : n;
    return `${n < 0n ? '-' : ''}R$\u00a0${(abs / 100n).toLocaleString('pt-BR')},${String(abs % 100n).padStart(2, '0')}`;
}
export function compararBens(a, b) {
    const x = inteiroExato(a?.valorCentavos), y = inteiroExato(b?.valorCentavos);
    if (x === null) return y === null ? 0 : 1;
    if (y === null) return -1;
    return x === y ? 0 : x > y ? -1 : 1;
}
export const estadosDados = Object.freeze({
    ok: 'Disponível', sem_fonte: 'Fonte não disponível', sem_registros: 'Sem registros na fonte consultada',
    valor_nao_informado: 'Valor não informado', parcial: 'Dados parciais',
});
export function valorFinanceiro(value, status) {
    if (status !== 'ok') return estadosDados[status] ?? `Estado não informado ou não reconhecido${status ? ': ' + status : ''}`;
    return fmtCentavos(value) ?? 'Valor não informado';
}
export function publicBase(value = '/') {
    if (typeof value !== 'string' || !/^\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]*\/?$/.test(value)) return '/';
    return value.endsWith('/') ? value : value + '/';
}
export function assetURL(arquivo, { base = '/', tipo, chave, sha256 } = {}) {
    if (typeof arquivo !== 'string') return null;
    const match = /^\/?assets\/(foto|certidao|proposta)\/(\d{4}_\d+_[A-Z]{2}_\d+)\/([a-f0-9]{64})\.(pdf|jpg|jpeg|png|webp)$/i.exec(arquivo);
    if (!match || !chaveCanonica(match[2]) || (tipo && match[1] !== tipo) || (chave && match[2] !== chave)) return null;
    if (sha256 != null && (!hashValido(sha256) || match[3].toLowerCase() !== sha256.toLowerCase())) return null;
    if (match[1] === 'foto' ? match[4].toLowerCase() === 'pdf' : match[4].toLowerCase() !== 'pdf') return null;
    return publicBase(base) + arquivo.replace(/^\//, '');
}
export function filtrarLista(lista, texto, uf, cargo) {
    const termo = normalizarTexto(texto), numero = /^\d+$/.test(termo);
    return lista.filter(c => (!uf || c.uf === uf) && (!cargo || c.cargo === cargo) &&
        (!termo || (numero ? String(c.numeroUrna ?? '').startsWith(termo) : normalizarTexto(c.nomeBusca ?? c.nome).includes(termo))))
        .sort((a, b) => numero ? String(a.numeroUrna ?? '').localeCompare(String(b.numeroUrna ?? ''), 'pt-BR', { numeric: true }) : String(a.nome ?? '').localeCompare(String(b.nome ?? ''), 'pt-BR'));
}
export const temasPropostas = Object.freeze([
    'Economia', 'Saúde', 'Segurança', 'Meio Ambiente', 'Educação', 'Infraestrutura',
    'Habitação', 'Assistência Social', 'Gestão Pública', 'Outros',
]);
export function agruparPropostas(afirmacoes) {
    const propostas = Array.isArray(afirmacoes) ? afirmacoes.filter(a => a?.tipo === 'proposta' && typeof a.texto === 'string' && a.texto.trim()) : [];
    return temasPropostas.map(tema => ({ tema, propostas: propostas.filter(a => (temasPropostas.includes(a.tema) ? a.tema : 'Outros') === tema) }))
        .filter(grupo => grupo.propostas.length);
}
export async function comPrazo(operacao, signal, prazoMs = 30000) {
    const controller = new AbortController();
    let timer, cancelar;
    try {
        return await Promise.race([
            new Promise((_, reject) => {
                cancelar = () => { controller.abort(); reject(new Error('Consulta cancelada.')); };
                if (signal?.aborted) return cancelar();
                signal?.addEventListener('abort', cancelar, { once: true });
                timer = setTimeout(() => {
                    controller.abort();
                    reject(new Error('O serviço não respondeu em 30 segundos. Consulte o estado do resumo antes de tentar gerar novamente.'));
                }, prazoMs);
            }),
            controller.signal.aborted ? Promise.reject(new Error('Consulta cancelada.')) : operacao(controller.signal),
        ]);
    } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', cancelar);
    }
}
export const estadosResumo = Object.freeze({
    documento_indisponivel: 'Documento indisponível', extracao_pendente: 'Extração pendente',
    rascunho_gerado: 'Rascunho completo — NÃO REVISADO', resumo_nao_preparado: 'Resumo ainda não preparado',
    revisao_necessaria: 'Controles da fonte exigem revisão', resumo_publicado: 'Resumo publicado',
    erro_geracao: 'Erro na consulta do resumo', falha_geracao: 'Falha de geração',
    bloqueio_quota: 'Geração bloqueada por quota', bloqueio_configuracao: 'Geração indisponível por configuração',
    processamento_offline_necessario: 'Documento extenso — processamento antecipado necessário',
});
export function selecaoDocumentos(documentos, selecionados) {
    const permitidos = new Set(documentos.map(d => d.sha256).filter(hashValido));
    return [...new Set(selecionados)].filter(hash => permitidos.has(hash));
}
// O token protege inclusive contra respostas de fetch que já terminaram ao abortar.
export function criarControleRequisicao() {
    let atual = 0, controller;
    return {
        cancelar() { atual++; controller?.abort(); },
        iniciar() {
            this.cancelar();
            controller = new AbortController();
            const token = atual;
            return { signal: controller.signal, vigente: () => token === atual };
        },
    };
}

export function descritorIndice(valor) {
    if (!valor || !hashValido(valor.versao) || !hashValido(valor.indice?.sha256)) return null;
    const esperado = `busca/${valor.versao}.${valor.indice.sha256}.json`;
    return valor.indice.arquivo === esperado ? Object.freeze({ arquivo: esperado, versao: valor.versao }) : null;
}

// LRU apenas em memória. Promessas em andamento são compartilhadas e falhas não ficam retidas.
export function criarCacheLimitado(limite = 12) {
    if (!Number.isSafeInteger(limite) || limite < 1) throw new TypeError('Limite de cache inválido.');
    const entradas = new Map();
    return Object.freeze({
        obter(chave, carregar) {
            if (entradas.has(chave)) {
                const valor = entradas.get(chave); entradas.delete(chave); entradas.set(chave, valor);
                return valor;
            }
            let promessa;
            try { promessa = Promise.resolve(carregar()); }
            catch (erro) { promessa = Promise.reject(erro); }
            entradas.set(chave, promessa);
            while (entradas.size > limite) entradas.delete(entradas.keys().next().value);
            promessa.catch(() => { if (entradas.get(chave) === promessa) entradas.delete(chave); });
            return promessa;
        },
        limpar() { entradas.clear(); },
        get tamanho() { return entradas.size; },
    });
}
