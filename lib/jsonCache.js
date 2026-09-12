// Cache em memória para leitura de arquivos JSON em /data
// Evita leituras redundantes do disco entre invocações da função serverless
// (válido enquanto a instância estiver quente — cold start sempre relê)

import fs from 'fs';
import path from 'path';

const cache = new Map();

// Lê e parseia um JSON de /data, com cache em memória
export function lerJSON(nomeArquivo) {
    if (cache.has(nomeArquivo)) {
        return cache.get(nomeArquivo);
    }
    try {
        const filePath = path.join(process.cwd(), 'data', nomeArquivo);
        const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        cache.set(nomeArquivo, data);
        return data;
    } catch {
        return null;
    }
}

// Lê e parseia um JSON de /public, com cache em memória
// Usado para arquivos de controle (EXPORTACAO_VALIDADA.json, manifesto_sha256.json)
export function lerJSONPublico(nomeArquivo) {
    const cacheKey = `__public__${nomeArquivo}`;
    if (cache.has(cacheKey)) {
        return cache.get(cacheKey);
    }
    try {
        const filePath = path.join(process.cwd(), 'public', nomeArquivo);
        const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        cache.set(cacheKey, data);
        return data;
    } catch {
        return null;
    }
}

// Busca uma chave com acesso direto
export function buscarPorChave(db, chave) {
    if (!db || !chave) return null;
    return db[chave] ?? null;
}

// Determina se uma string é a chave canônica: ANO_CD_UF_SQ
// Formato: 4 segmentos separados por '_'; primeiro segmento numérico de 4 dígitos.
// Exemplos válidos: '2026_6259_MG_130002539775', '2026_6257_BR_280002538811'
export function ehChaveCanonica(id) {
    if (!id || typeof id !== 'string') return false;
    const partes = id.split('_');
    return partes.length === 4 && /^\d{4}$/.test(partes[0]);
}

// Resolve um ID legado (UF_SQ) para a chave canônica via aliases_legados.json.
// Retorna a chave canônica (string) se o mapeamento for inequívoco.
// Retorna null se o ID não existir, for ambíguo ou se os aliases não estiverem disponíveis.
// NUNCA escolhe a primeira candidatura quando há ambiguidade.
export function resolverAliasLegado(idLegado) {
    if (!idLegado || typeof idLegado !== 'string') return null;
    const aliases = lerJSON('aliases_legados.json');
    if (!aliases || typeof aliases !== 'object') return null;
    const chave = aliases[idLegado];
    return typeof chave === 'string' ? chave : null;
}

// Verifica o marcador de exportação validada.
// Retorna { ok: true } para pacotes consumíveis, ou { ok: false, motivo } para bloqueados/incompletos.
// VALIDADO_COM_AVISOS é consumível (respeite os avisos nos dados).
// Não valida hashes do manifesto em tempo de execução (custo proibitivo por request).
export function verificarExportacao() {
    const marcador = lerJSONPublico('EXPORTACAO_VALIDADA.json');
    if (!marcador) {
        return { ok: false, motivo: 'Marcador EXPORTACAO_VALIDADA.json não encontrado em public/.' };
    }
    const statusBloqueados = ['BLOQUEADA', 'INCOMPLETA', 'REJEITADA'];
    if (statusBloqueados.includes(marcador.status)) {
        return { ok: false, motivo: `Exportação com status '${marcador.status}' não pode ser consumida.` };
    }
    return { ok: true, status: marcador.status, runId: marcador.runId };
}

// Limpa o cache (útil para testes ou quando dados forem atualizados)
export function limparCache(nomeArquivo) {
    if (nomeArquivo) {
        cache.delete(nomeArquivo);
        cache.delete(`__public__${nomeArquivo}`);
    } else {
        cache.clear();
    }
}