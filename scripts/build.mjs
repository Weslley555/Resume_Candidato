import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { carregarSnapshot, caminhoSeguro, sha256 } from '../lib/exportacao.js';
import { metadadosPublicos } from '../lib/apiDados.js';
import { gerarRuntime } from '../lib/runtimeSnapshot.js';

const ESTATICOS = ['index.html', 'privacidade.html', 'termos-de-uso.html', 'script.js', 'style.css'];

export function build(raiz = process.cwd()) {
    raiz = path.resolve(raiz);
    const snapshot = carregarSnapshot(raiz);
    const lock = path.join(raiz, '.build.lock');
    const lockFd = fs.openSync(lock, 'wx');
    let temporario;
    let runtimeTemporario;
    const destino = path.join(raiz, 'dist');
    const runtimeDestino = path.join(raiz, 'runtime');
    const publicacaoLock = path.join(raiz, '.build-publicacao.lock');
    const inventarioCopiado = [];
    let anterior;
    let runtimeAnterior;
    function copiar(origem, relativo, saida, hash) {
        const buffer = fs.readFileSync(caminhoSeguro(origem, relativo));
        if (hash && sha256(buffer) !== hash) throw new Error(`Asset mudou durante build: ${relativo}`);
        const arquivo = path.join(temporario, saida);
        fs.mkdirSync(path.dirname(arquivo), { recursive: true });
        fs.writeFileSync(arquivo, buffer, { flag: 'wx' });
        if (hash) {
            const hashCopiado = sha256(fs.readFileSync(caminhoSeguro(temporario, saida)));
            if (hashCopiado !== hash) throw new Error(`Hash do asset copiado diverge: ${saida}`);
            inventarioCopiado.push([saida, hashCopiado]);
        }
    }
    function copiarArvore(relativo, extensoes) {
        const pasta = path.join(raiz, relativo);
        if (!fs.existsSync(pasta)) return;
        if (fs.lstatSync(pasta).isSymbolicLink()) throw new Error(`Link estático proibido: ${relativo}`);
        for (const entrada of fs.readdirSync(pasta, { withFileTypes: true })) {
            const nome = `${relativo}/${entrada.name}`;
            if (entrada.isSymbolicLink()) throw new Error(`Link estático proibido: ${nome}`);
            if (entrada.isDirectory()) copiarArvore(nome, extensoes);
            else if (extensoes.has(path.extname(entrada.name))) copiar(raiz, nome, nome.replace(/^public\//, ''));
        }
    }
    try {
        temporario = fs.mkdtempSync(path.join(raiz, '.build-'));
        runtimeTemporario = fs.mkdtempSync(path.join(raiz, '.build-runtime-'));
        for (const nome of ESTATICOS) copiar(raiz, `public/${nome}`, nome);
        if (fs.existsSync(path.join(raiz, 'public/frontend-helpers.mjs'))) {
            copiar(raiz, 'public/frontend-helpers.mjs', 'frontend-helpers.mjs');
        }
        copiarArvore('public/icons', new Set(['.svg', '.png', '.ico', '.webp']));
        copiarArvore('fonts', new Set(['.woff', '.woff2', '.ttf', '.otf']));
        for (const [nome, hash] of Object.entries(snapshot.controles['manifesto_sha256.json'])) {
            if (nome.startsWith('assets/')) copiar(snapshot.raiz, `${snapshot.prefixoPublico}${nome}`, nome, hash);
        }
        // Deriva a busca somente do snapshot integral validado. O caminho contém a
        // identidade da exportação e o conteúdo carrega a mesma identidade.
        const camposBusca = ['chave', 'nome', 'nomeBusca', 'uf', 'cargo', 'numeroUrna'];
        const lista = snapshot.dados['lista_busca.json'].map(registro =>
            Object.fromEntries(camposBusca.map(campo => [campo, registro[campo] ?? null])));
        const indice = Buffer.from(JSON.stringify({
            exportacao: snapshot.versao,
            metadados: metadadosPublicos(snapshot.dados['metadados.json']),
            lista,
        }) + '\n');
        const indiceSHA256 = sha256(indice);
        const indiceArquivo = `busca/${snapshot.versao}.${indiceSHA256}.json`;
        fs.mkdirSync(path.join(temporario, 'busca'), { recursive: true });
        fs.writeFileSync(path.join(temporario, indiceArquivo), indice, { flag: 'wx' });
        const resultado = { ok: true, status: snapshot.status, runId: snapshot.runId, versao: snapshot.versao,
            indice: { arquivo: indiceArquivo, sha256: indiceSHA256 } };
        const identidadePublica = Buffer.from(JSON.stringify(resultado) + '\n');
        fs.writeFileSync(path.join(temporario, 'exportacao.json'), identidadePublica);
        if (sha256(fs.readFileSync(caminhoSeguro(temporario, indiceArquivo))) !== indiceSHA256
            || !fs.readFileSync(caminhoSeguro(temporario, 'exportacao.json')).equals(identidadePublica)) {
            throw new Error('Busca/identidade pública diverge do snapshot');
        }
        gerarRuntime(snapshot, runtimeTemporario, inventarioCopiado);
        // Não há rename atômico de dois diretórios. Cada árvore é ativada completa;
        // o lock bloqueia novos loaders locais durante a troca e há rollback do par.
        const publicacaoFd = fs.openSync(publicacaoLock, 'wx');
        let distAtivado = false;
        let runtimeAtivado = false;
        let recuperado = false;
        try {
            for (const pasta of [destino, runtimeDestino]) {
                if (fs.existsSync(pasta) && fs.lstatSync(pasta).isSymbolicLink()) throw new Error(`Destino não pode ser link: ${pasta}`);
            }
            if (fs.existsSync(destino)) {
                const backup = path.join(raiz, `.build-anterior-${randomUUID()}`);
                fs.renameSync(destino, backup);
                anterior = backup;
            }
            if (fs.existsSync(runtimeDestino)) {
                const backup = path.join(raiz, `.build-anterior-runtime-${randomUUID()}`);
                fs.renameSync(runtimeDestino, backup);
                runtimeAnterior = backup;
            }
            fs.renameSync(temporario, destino);
            distAtivado = true;
            fs.renameSync(runtimeTemporario, runtimeDestino);
            runtimeAtivado = true;
            recuperado = true;
        } catch (erro) {
            if (runtimeAtivado) fs.renameSync(runtimeDestino, runtimeTemporario);
            if (distAtivado) fs.renameSync(destino, temporario);
            if (runtimeAnterior) fs.renameSync(runtimeAnterior, runtimeDestino);
            if (anterior) fs.renameSync(anterior, destino);
            recuperado = true;
            throw erro;
        } finally {
            fs.closeSync(publicacaoFd);
            // Se o rollback falhar, manter o lock para impedir fallback/mistura.
            if (recuperado) fs.unlinkSync(publicacaoLock);
        }
        return { ...resultado, saida: destino, runtime: runtimeDestino, anterior, runtimeAnterior };
    } finally {
        if (temporario && fs.existsSync(temporario)) fs.rmSync(temporario, { recursive: true, force: true });
        if (runtimeTemporario && fs.existsSync(runtimeTemporario)) fs.rmSync(runtimeTemporario, { recursive: true, force: true });
        fs.closeSync(lockFd);
        fs.unlinkSync(lock);
    }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try {
        if (process.argv.length !== 2) throw new Error('Uso: npm run build');
        console.log(JSON.stringify(build(), null, 2));
    } catch (erro) {
        console.error(`Build bloqueado: ${erro.message}`);
        process.exitCode = 1;
    }
}
