import fs from 'node:fs';
import path from 'node:path';
import {
    ARQUIVOS_DADOS, CONTROLES, caminhoSeguro, carregarSnapshot, exigirSnapshotIntegral,
    sha256, validarConteudoSnapshot,
} from './exportacao.js';

const RECIBO = 'recibo_build.json';
const serializar = x => Buffer.from(JSON.stringify(x) + '\n');
export function inventarioAssets(manifesto) {
    return Object.entries(manifesto).filter(([nome]) => nome.startsWith('assets/'))
        .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
}
function reciboEsperado(snapshot) {
    const inventario = inventarioAssets(snapshot.controles[CONTROLES[1]]);
    return {
        tipo: 'resume-candidato-runtime-build', schemaVersion: 1,
        runId: snapshot.runId, versao: snapshot.versao,
        manifestoSHA256: sha256(snapshot.manifestoBytes),
        marcadorSHA256: sha256(snapshot.marcadorBytes),
        inventarioAssetsSHA256: sha256(serializar(inventario)),
        quantidadeAssets: inventario.length,
        dadosSHA256: Object.fromEntries(ARQUIVOS_DADOS.map(nome => [nome, sha256(snapshot.dadosBytes[nome])])),
    };
}

// Recibo derivado pelo build, não uma assinatura de origem. A fronteira de confiança
// é o filesystem privado/imutável do deploy. Quem pode reescrever todo o deploy
// também pode falsificar o recibo; o marcador do pacote sozinho nunca o substitui.
export function carregarRuntime(pasta) {
    const reciboBytes = fs.readFileSync(caminhoSeguro(pasta, RECIBO));
    const snapshot = validarConteudoSnapshot(pasta);
    if (!reciboBytes.equals(serializar(reciboEsperado(snapshot)))) {
        throw new Error('Runtime inválido: recibo de build divergente');
    }
    return { ...snapshot, runtime: true };
}

// Só aceita objetos emitidos pela validação integral e inventário dos bytes
// efetivamente copiados para dist. O staging é relido antes da ativação.
export function gerarRuntime(snapshot, pasta, inventarioCopiado) {
    exigirSnapshotIntegral(snapshot);
    const esperado = inventarioAssets(snapshot.controles[CONTROLES[1]]);
    const copiado = [...inventarioCopiado].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
    if (!serializar(copiado).equals(serializar(esperado))) throw new Error('Inventário copiado para dist diverge do manifesto');
    function escrever(nome, buffer) {
        const arquivo = path.join(pasta, nome);
        fs.mkdirSync(path.dirname(arquivo), { recursive: true });
        fs.writeFileSync(arquivo, buffer, { flag: 'wx' });
    }
    for (const nome of ARQUIVOS_DADOS) escrever(`data/${nome}`, snapshot.dadosBytes[nome]);
    escrever(`public/${CONTROLES[0]}`, snapshot.marcadorBytes);
    escrever(`public/${CONTROLES[1]}`, snapshot.manifestoBytes);
    escrever(RECIBO, serializar(reciboEsperado(snapshot)));
    const runtime = carregarRuntime(pasta);
    if (runtime.runId !== snapshot.runId || runtime.versao !== snapshot.versao) throw new Error('Runtime gerado com identidade divergente');
    return runtime;
}

export function carregarFonteSnapshot(raiz = process.cwd()) {
    try {
        fs.lstatSync(path.join(raiz, '.build-publicacao.lock'));
        throw new Error('Publicação de dist/runtime em andamento; reinicie após o build');
    } catch (erro) { if (erro.code !== 'ENOENT') throw erro; }
    const pasta = path.join(raiz, 'runtime');
    try {
        const stat = fs.lstatSync(pasta);
        if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('Runtime inválido: pasta deve ser diretório sem link');
    } catch (erro) {
        if (erro.code === 'ENOENT') return { ...carregarSnapshot(raiz), runtime: false };
        throw erro;
    }
    // Presença de runtime, mesmo incompleto, proíbe fallback para os dados locais.
    return carregarRuntime(pasta);
}
