import fs from 'node:fs';
import path from 'node:path';
import { sha256, serializar } from './resumos.js';

// Identifica unicamente um job pelos parâmetros que determinam os blocos e o output.
// Mudança em qualquer um invalida todos os checkpoints do job.
export function chaveJob(params) {
    return sha256(Buffer.from(serializar(params)));
}

export function nomeBlocoArquivo(index) {
    return `bloco-${String(index).padStart(5, '0')}.json`;
}

// Tenta adquirir o lock do job. Retorna o fd se conseguiu, null se já estava bloqueado.
// Exclusão mútua: apenas um processo processa o mesmo job simultaneamente.
export function adquirirLock(jobDir) {
    fs.mkdirSync(jobDir, { recursive: true });
    try {
        return fs.openSync(path.join(jobDir, 'lock'), 'wx');
    } catch (err) {
        if (err.code === 'EEXIST') return null;
        throw err;
    }
}

export function liberarLock(fd, jobDir) {
    try { fs.closeSync(fd); } catch { /* já fechado */ }
    try { fs.unlinkSync(path.join(jobDir, 'lock')); } catch { /* já removido */ }
}

// Lê os parâmetros salvos do job para detectar incompatibilidade.
export function lerParametrosJob(jobDir) {
    try {
        return JSON.parse(fs.readFileSync(path.join(jobDir, 'job.json'), 'utf8'));
    } catch { return null; }
}

export function salvarParametrosJob(jobDir, params) {
    fs.mkdirSync(jobDir, { recursive: true });
    const arquivo = path.join(jobDir, 'job.json');
    const tmp = arquivo + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(params, null, 2) + '\n');
    fs.renameSync(tmp, arquivo);
}

// Lê o checkpoint de um bloco já concluído. Retorna null se ausente ou corrompido.
export function lerCheckpoint(jobDir, index) {
    try {
        return JSON.parse(fs.readFileSync(path.join(jobDir, nomeBlocoArquivo(index)), 'utf8'));
    } catch { return null; }
}

// Salva checkpoint atômico: grava em .tmp e renomeia, nunca sobrescreve parcialmente.
export function salvarCheckpoint(jobDir, index, dados) {
    fs.mkdirSync(jobDir, { recursive: true });
    const arquivo = path.join(jobDir, nomeBlocoArquivo(index));
    const tmp = arquivo + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(dados, null, 2) + '\n');
    fs.renameSync(tmp, arquivo);
}

export function lerRascunho(jobDir) {
    try {
        return JSON.parse(fs.readFileSync(path.join(jobDir, 'rascunho.json'), 'utf8'));
    } catch { return null; }
}

// Salva o rascunho final de forma atômica.
export function salvarRascunho(jobDir, registro) {
    fs.mkdirSync(jobDir, { recursive: true });
    const tmp = path.join(jobDir, 'rascunho.json.tmp');
    fs.writeFileSync(tmp, JSON.stringify(registro, null, 2) + '\n');
    fs.renameSync(tmp, path.join(jobDir, 'rascunho.json'));
}

// Remove todo o job (checkpoints + lock + parâmetros).
// Chamado quando os parâmetros do job mudaram e os checkpoints estão inválidos.
export function invalidarJob(jobDir) {
    fs.rmSync(jobDir, { recursive: true, force: true });
}

// Lista quais blocos de um job estão completos (têm checkpoint válido).
export function blocosConcluidos(jobDir, blocosOuTotal, validar) {
    const totalBlocos = Array.isArray(blocosOuTotal) ? blocosOuTotal.length : blocosOuTotal;
    const concluidos = [];
    for (let i = 0; i < totalBlocos; i++) {
        const checkpoint = lerCheckpoint(jobDir, i);
        if (checkpoint !== null && (!validar || validar(checkpoint, i, blocosOuTotal[i]))) concluidos.push(i);
    }
    return concluidos;
}
