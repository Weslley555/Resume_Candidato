import { ARQUIVOS_DADOS, CONTROLES, ehChaveCanonica, congelar } from './exportacao.js';
import { carregarFonteSnapshot } from './runtimeSnapshot.js';

export { ehChaveCanonica };
let snapshot;
let resultado;
const cache = new Map();

function inicializar() {
    if (resultado) return;
    try {
        snapshot = carregarFonteSnapshot();
        resultado = Object.freeze({ ok: true, status: snapshot.status, runId: snapshot.runId, versao: snapshot.versao });
    } catch (erro) {
        // Falha fechada e persistente: ativar outra versão exige um novo processo.
        resultado = Object.freeze({ ok: false, status: null, runId: null, motivo: erro.message });
    }
}

export function verificarExportacao() {
    inicializar();
    return resultado;
}

// Não expõe buffers mutáveis nem caminhos internos.
export function obterSnapshot() {
    inicializar();
    return snapshot ? congelar({ ...resultado, dados: snapshot.dados, controles: snapshot.controles }) : null;
}

// Contrato interno: consumidores usam estes dados, nunca resolvem novamente a raiz.
// lerBytes devolve cópias para não permitir mutação dos bytes fixos do processo.
export function obterFonteSnapshot() {
    inicializar();
    if (!snapshot) return null;
    return Object.freeze({
        ...resultado, raiz: snapshot.raiz, runtime: snapshot.runtime,
        dados: snapshot.dados, controles: snapshot.controles,
        lerBytes(nomeArquivo) {
            if (ARQUIVOS_DADOS.includes(nomeArquivo)) return Buffer.from(snapshot.dadosBytes[nomeArquivo]);
            if (nomeArquivo === CONTROLES[0]) return Buffer.from(snapshot.marcadorBytes);
            if (nomeArquivo === CONTROLES[1]) return Buffer.from(snapshot.manifestoBytes);
            return null;
        },
    });
}

export function lerJSON(nomeArquivo) {
    if (!ARQUIVOS_DADOS.includes(nomeArquivo)) return null;
    inicializar();
    if (!snapshot) return null;
    if (!cache.has(nomeArquivo)) cache.set(nomeArquivo, snapshot.dados[nomeArquivo]);
    return cache.get(nomeArquivo);
}

export function lerJSONPublico(nomeArquivo) {
    if (nomeArquivo === 'lista_busca.json') return lerJSON(nomeArquivo);
    if (!CONTROLES.includes(nomeArquivo)) return null;
    inicializar();
    return snapshot?.controles[nomeArquivo] ?? null;
}

export function buscarPorChave(db, chave) {
    return db && typeof chave === 'string' && Object.hasOwn(db, chave) ? db[chave] ?? null : null;
}

export function resolverAliasLegado(idLegado) {
    if (typeof idLegado !== 'string' || !/^[A-Z]{2}_\d+$/.test(idLegado)) return null;
    const chave = buscarPorChave(lerJSON('aliases_legados.json'), idLegado);
    return ehChaveCanonica(chave) ? chave : null;
}

// Limpa apenas a memoização; nunca reabre arquivos nem muda o snapshot do processo.
export function limparCache(nomeArquivo) {
    if (nomeArquivo) cache.delete(nomeArquivo);
    else cache.clear();
}
