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

// Busca uma chave com acesso direto
export function buscarPorChave(db, id) {
    if (!db || !id) return null;
    return db[id] ?? null;
}

// Limpa o cache (útil para testes ou quando dados forem atualizados)
export function limparCache(nomeArquivo) {
    if (nomeArquivo) {
        cache.delete(nomeArquivo);
    } else {
        cache.clear();
    }
}