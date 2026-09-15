import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export const ARQUIVOS_DADOS = Object.freeze([
    'aliases_legados.json', 'candidatos.json', 'documentos.json', 'financeiro.json',
    'fotos.json', 'juridico.json', 'lista_busca.json', 'metadados.json',
    'patrimonio.json', 'textos_propostas.json', 'verificacao_dados.json',
]);
export const CONTROLES = Object.freeze(['EXPORTACAO_VALIDADA.json', 'manifesto_sha256.json']);
const STATUS = new Set(['VALIDADA_TECNICAMENTE', 'VALIDADO', 'VALIDADO_COM_AVISOS']);
const HASH = /^[a-f0-9]{64}$/;
export const ehChaveCanonica = id => typeof id === 'string' && /^\d{4}_\d+_[A-Z]{2}_\d+$/.test(id);
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const objeto = x => x !== null && typeof x === 'object' && !Array.isArray(x);
function exigir(condicao, mensagem) {
    if (!condicao) throw new Error(`Exportação inválida: ${mensagem}`);
}
export function congelar(x) {
    if (x && typeof x === 'object' && !Object.isFrozen(x)) {
        Object.values(x).forEach(congelar);
        Object.freeze(x);
    }
    return x;
}

// Rejeita também junctions/symlinks e nomes ambíguos no Windows.
export function caminhoSeguro(raiz, relativo) {
    exigir(typeof relativo === 'string' && relativo.length > 0, 'caminho vazio');
    const partes = relativo.split('/');
    exigir(partes.every(p => /^[a-zA-Z0-9_,.-]+$/.test(p) && p !== '.' && p !== '..'
        && !/[. ]$/.test(p) && !/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(p)), `caminho proibido: ${relativo}`);
    let atual = path.resolve(raiz);
    exigir(!fs.lstatSync(atual).isSymbolicLink(), `link proibido: ${atual}`);
    for (const parte of partes) {
        atual = path.join(atual, parte);
        const stat = fs.lstatSync(atual);
        exigir(!stat.isSymbolicLink(), `link proibido: ${relativo}`);
    }
    exigir(fs.statSync(atual).isFile(), `não é arquivo: ${relativo}`);
    return atual;
}
function bytes(raiz, relativo) {
    return fs.readFileSync(caminhoSeguro(raiz, relativo));
}
function parse(buffer, nome) {
    try {
        return JSON.parse(buffer.toString('utf8'), (k, v) => {
            exigir(!['__proto__', 'constructor', 'prototype'].includes(k), `propriedade proibida em ${nome}`);
            return v;
        });
    } catch (erro) {
        throw new Error(`JSON inválido em ${nome}: ${erro.message}`);
    }
}
function validarCentavos(valor, contexto) {
    exigir(valor === null || (typeof valor === 'string' && /^-?\d+$/.test(valor)), `centavos inválidos: ${contexto}`);
}
function validarCamposMonetarios(registro, contexto) {
    if (!registro || typeof registro !== 'object') return;
    for (const [campo, valor] of Object.entries(registro)) {
        if (/centavos$/i.test(campo)) validarCentavos(valor, `${contexto}.${campo}`);
        else if (valor && typeof valor === 'object') validarCamposMonetarios(valor, `${contexto}.${campo}`);
    }
}
function validarLancamentos(registro, lista, quantidade, total, status, zeros, contexto) {
    const itens = registro[lista];
    exigir(Array.isArray(itens) && itens.every(objeto), `lançamentos inválidos: ${contexto}.${lista}`);
    const ok = registro[status] === 'ok';
    if (ok || Object.hasOwn(registro, quantidade)) {
        exigir(Number.isSafeInteger(registro[quantidade]) && registro[quantidade] === itens.length, `contagem divergente: ${contexto}.${quantidade}`);
    }
    if (Object.hasOwn(registro, zeros)) {
        const contagemZeros = itens.filter(x => typeof x.valorCentavos === 'string' && BigInt(x.valorCentavos) === 0n).length;
        exigir(Number.isSafeInteger(registro[zeros]) && registro[zeros] === contagemZeros, `contagem divergente: ${contexto}.${zeros}`);
    }
    if (!ok) return;
    exigir(typeof registro[total] === 'string' && itens.every(x => typeof x.valorCentavos === 'string'), `centavos ausentes com status ok: ${contexto}.${lista}`);
    // Não deduplicar lançamentos nem converter dinheiro para Number.
    const soma = itens.reduce((acumulado, x) => acumulado + BigInt(x.valorCentavos), 0n);
    exigir(BigInt(registro[total]) === soma, `total exato divergente: ${contexto}.${total}`);
}
function validarDados(dados, manifesto, marcador) {
    const db = nome => dados[`${nome}.json`];
    for (const nome of ARQUIVOS_DADOS) {
        exigir(nome === 'lista_busca.json' ? Array.isArray(dados[nome]) : objeto(dados[nome]), `formato de ${nome}`);
    }
    const candidatos = db('candidatos');
    const chaves = Object.keys(candidatos);
    exigir(chaves.length > 0, 'nenhum candidato');
    const identidade = (c, chave) => {
        exigir(objeto(c) && ehChaveCanonica(chave) && c.chave === chave
            && [c.anoEleicao, c.codigoEleicao, c.uf, c.id].every(v => typeof v === 'string')
            && `${c.anoEleicao}_${c.codigoEleicao}_${c.uf}_${c.id}` === chave, `identidade divergente: ${chave}`);
    };
    for (const chave of chaves) identidade(candidatos[chave], chave);
    for (const nome of ['documentos', 'financeiro', 'fotos', 'juridico', 'patrimonio', 'textos_propostas']) {
        const mapa = db(nome);
        exigir(Object.keys(mapa).length === chaves.length && chaves.every(k => Object.hasOwn(mapa, k)), `cobertura de ${nome}`);
        for (const [k, v] of Object.entries(mapa)) {
            exigir(nome === 'textos_propostas' ? Array.isArray(v) : objeto(v), `registro de ${nome}: ${k}`);
        }
    }
    const meta = db('metadados');
    const auditoria = db('verificacao_dados');
    exigir(STATUS.has(meta.status) && STATUS.has(auditoria.status), 'status dos dados');
    if (Object.hasOwn(meta, 'totalCandidatos')) exigir(meta.totalCandidatos === chaves.length, 'metadados: totalCandidatos divergente');
    if (Object.hasOwn(meta, 'geradoEm')) exigir(typeof meta.geradoEm === 'string' && Number.isFinite(Date.parse(meta.geradoEm)), 'metadados: geradoEm inválido');
    exigir(objeto(meta.escopo) && /^\d{4}$/.test(String(meta.escopo.ano)) && Array.isArray(meta.escopo.ufs), 'escopo inválido');
    if (Object.hasOwn(auditoria, 'escopo')) {
        exigir(objeto(auditoria.escopo) && String(auditoria.escopo.ano) === String(meta.escopo.ano)
            && Array.isArray(auditoria.escopo.ufs)
            && new Set(auditoria.escopo.ufs).size === new Set(meta.escopo.ufs).size
            && auditoria.escopo.ufs.every(uf => meta.escopo.ufs.includes(uf)), 'escopo divergente');
    }
    for (const [registro, campo] of [[meta, 'arquivosFonte'], [auditoria, 'fontes'], [auditoria, 'eventos']]) {
        if (Object.hasOwn(registro, campo)) exigir(Array.isArray(registro[campo]), `formato de ${campo}`);
    }
    if (Object.hasOwn(auditoria, 'reconciliacao')) exigir(objeto(auditoria.reconciliacao), 'formato de reconciliacao');
    for (const x of [meta, auditoria]) {
        if (Object.hasOwn(x, 'runId')) exigir(x.runId === marcador.runId, 'runId divergente');
    }
    const grupos = new Map();
    for (const [k, c] of Object.entries(candidatos)) {
        exigir(c.anoEleicao === String(meta.escopo.ano) && meta.escopo.ufs.includes(c.uf), `fora do escopo: ${k}`);
        const legado = `${c.uf}_${c.id}`;
        grupos.set(legado, [...(grupos.get(legado) ?? []), k]);
    }
    const aliases = db('aliases_legados');
    exigir(Object.keys(aliases).every(legado => grupos.has(legado)), 'alias desconhecido');
    for (const [legado, ks] of grupos) {
        const alias = aliases[legado];
        exigir(ks.length === 1 ? alias === ks[0] : !Object.hasOwn(aliases, legado) || alias === null ||
            (Array.isArray(alias) && alias.length === ks.length && new Set(alias).size === ks.length && ks.every(k => alias.includes(k))), `alias inconsistente: ${legado}`);
    }
    const usados = new Set();
    function vinculo(registro, campo, tipo, chave, hashOpcional = false) {
        exigir(objeto(registro), `asset inválido: ${chave}`);
        const arquivo = registro[campo];
        const hash = manifesto[arquivo];
        exigir(typeof arquivo === 'string' && arquivo.startsWith(`assets/${tipo}/${chave}/`)
            && typeof hash === 'string' && HASH.test(hash)
            && ((hashOpcional && !Object.hasOwn(registro, 'sha256')) || registro.sha256 === hash)
            && path.posix.basename(arquivo).startsWith(`${hash}.`), `vínculo/hash de asset: ${chave}`);
        usados.add(arquivo);
        return arquivo;
    }
    let totalFotos = 0;
    for (const chave of chaves) {
        const foto = db('fotos')[chave];
        if (foto.arquivo !== null) {
            exigir(foto.status === 'ok', `status da foto: ${chave}`);
            vinculo(foto, 'arquivo', 'foto', chave, true);
            totalFotos++;
        }
        const docs = db('documentos')[chave];
        for (const [campo, tipo] of [['propostas', 'proposta'], ['certidoes', 'certidao']]) {
            exigir(Array.isArray(docs[campo]), `documentos.${campo}: ${chave}`);
            const arquivos = docs[campo].map(d => vinculo(d, 'caminho', tipo, chave));
            exigir(new Set(arquivos).size === arquivos.length, `documento duplicado: ${chave}`);
        }
        const textos = db('textos_propostas')[chave];
        exigir(textos.length === docs.propostas.length, `cobertura dos PDFs: ${chave}`);
        const vistos = new Set();
        for (const pdf of textos) {
            const arquivo = vinculo(pdf, 'arquivo', 'proposta', chave);
            exigir(!vistos.has(arquivo) && docs.propostas.some(d => d.caminho === arquivo && d.sha256 === pdf.sha256 && d.nome === pdf.nome), `PDF sem documento: ${chave}`);
            vistos.add(arquivo);
            if (pdf.sha256Fonte != null) exigir(typeof pdf.sha256Fonte === 'string' && HASH.test(pdf.sha256Fonte), `hash fonte PDF inválido: ${chave}`);
            exigir((pdf.texto == null || typeof pdf.texto === 'string')
                && (pdf.totalPaginas == null || (Number.isSafeInteger(pdf.totalPaginas) && pdf.totalPaginas > 0))
                && (pdf.paginas == null || Array.isArray(pdf.paginas))
                && (pdf.statusExtracao == null || typeof pdf.statusExtracao === 'string'), `formato PDF/páginas: ${chave}`);
            // Extração incompleta não invalida o pacote. Mesmo aptoParaRascunho=true
            // não substitui a análise de cobertura/pendências feita pela API de resumo.
            if (pdf.aptoParaRascunho != null) exigir(typeof pdf.aptoParaRascunho === 'boolean', `aptoParaRascunho inválido: ${chave}`);
            const numerosPaginas = new Set();
            for (const p of pdf.paginas ?? []) {
                exigir(objeto(p) && Number.isSafeInteger(p.pagina) && p.pagina > 0
                    && !numerosPaginas.has(p.pagina) && (pdf.totalPaginas == null || p.pagina <= pdf.totalPaginas)
                    && (p.texto == null || typeof p.texto === 'string') && (p.metodo == null || typeof p.metodo === 'string')
                    && (p.status == null || typeof p.status === 'string') && (p.revisar == null || typeof p.revisar === 'boolean'), `página inválida: ${chave}`);
                numerosPaginas.add(p.pagina);
            }
        }
        const patrimonio = db('patrimonio')[chave];
        exigir(Array.isArray(patrimonio.bens) && patrimonio.quantidade === patrimonio.bens.length
            && typeof patrimonio.status === 'string', `patrimônio inválido: ${chave}`);
        validarCamposMonetarios(patrimonio, `patrimonio.${chave}`);
        validarLancamentos(patrimonio, 'bens', 'quantidade', 'totalCentavos', 'status', 'zerosExplicitos', `patrimonio.${chave}`);
        for (const campo of ['prestadores', 'receitas', 'despesasContratadas', 'pagamentos', 'doadoresOriginarios']) {
            exigir(Array.isArray(db('financeiro')[chave][campo]), `financeiro.${campo}: ${chave}`);
        }
        const financeiro = db('financeiro')[chave];
        validarCamposMonetarios(financeiro, `financeiro.${chave}`);
        for (const campos of [
            ['receitas', 'quantidade_receitas', 'total_arrecadado_centavos', 'status_receitas', 'receitas_zeros_explicitos'],
            ['despesasContratadas', 'quantidade_despesas_contratadas', 'total_contratado_centavos', 'status_contratadas', 'contratadas_zeros_explicitos'],
            ['pagamentos', 'quantidade_despesas_pagas', 'total_pago_centavos', 'status_pagamento', 'pagas_zeros_explicitos'],
        ]) validarLancamentos(financeiro, ...campos, `financeiro.${chave}`);
        exigir(typeof db('juridico')[chave].status === 'string' && Array.isArray(db('juridico')[chave].motivoCassacao)
            && Array.isArray(db('juridico')[chave].registrosCassacao), `jurídico inválido: ${chave}`);
    }
    if (Object.hasOwn(meta, 'totalFotos')) exigir(meta.totalFotos === totalFotos, 'totalFotos divergente');
    const lista = db('lista_busca');
    const vistos = new Set();
    exigir(lista.length === chaves.length, 'cobertura de lista_busca');
    for (const c of lista) {
        identidade(c, c?.chave);
        exigir(Object.hasOwn(candidatos, c.chave) && !vistos.has(c.chave), 'lista_busca desconhecida/duplicada');
        vistos.add(c.chave);
        for (const campo of ['id', 'uf', 'anoEleicao', 'codigoEleicao', 'numeroUrna', 'nomeUrna', 'nomeCompleto', 'cargo', 'partido']) {
            exigir(c[campo] === candidatos[c.chave][campo], `lista_busca divergente: ${campo}/${c.chave}`);
        }
        exigir(typeof c.nome === 'string' && typeof c.nomeBusca === 'string'
            && c.foto === db('fotos')[c.chave].arquivo, `lista_busca foto/nome: ${c.chave}`);
    }
    exigir(Object.keys(manifesto).filter(k => k.startsWith('assets/')).every(k => usados.has(k)), 'asset sem vínculo');
}

const snapshotsIntegrais = new WeakSet();
export function exigirSnapshotIntegral(snapshot) {
    exigir(snapshotsIntegrais.has(snapshot), 'geração de runtime exige snapshot integral validado neste processo');
}

// Compartilhado com o loader privado de runtime. Não certifica os bytes dos assets.
// JSONs são retidos a partir dos próprios bytes conferidos, nunca relidos sob demanda.
export function validarConteudoSnapshot(raiz, { layout = 'projeto' } = {}) {
    raiz = path.resolve(raiz);
    exigir(['projeto', 'notebook', 'auto'].includes(layout), 'layout desconhecido');
    if (layout === 'auto') {
        const presente = nome => {
            try { fs.lstatSync(path.join(raiz, nome)); return true; }
            catch (erro) { if (erro.code === 'ENOENT') return false; throw erro; }
        };
        const projeto = CONTROLES.some(n => presente(`public/${n}`));
        const notebook = CONTROLES.some(presente);
        exigir(projeto !== notebook, 'layout ausente ou ambíguo: controles na raiz e/ou public/');
        layout = projeto ? 'projeto' : 'notebook';
    }
    const prefixoPublico = layout === 'notebook' ? '' : 'public/';
    const marcadorBytes = bytes(raiz, `${prefixoPublico}EXPORTACAO_VALIDADA.json`);
    const manifestoBytes = bytes(raiz, `${prefixoPublico}manifesto_sha256.json`);
    const marcador = parse(marcadorBytes, CONTROLES[0]);
    const manifesto = parse(manifestoBytes, CONTROLES[1]);
    exigir(objeto(marcador) && STATUS.has(marcador.status), 'status do marcador não permitido');
    exigir(typeof marcador.runId === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(marcador.runId), 'runId inválido');
    const versao = sha256(manifestoBytes);
    exigir(marcador.manifestoSHA256 === versao, 'hash do manifesto diverge do marcador');
    exigir(objeto(manifesto), 'manifesto deve ser mapa path->sha256');
    const dados = {};
    const dadosBytes = {};
    for (const nome of ARQUIVOS_DADOS) exigir(Object.hasOwn(manifesto, `data/${nome}`), `ausente no manifesto: data/${nome}`);
    for (const [nome, hash] of Object.entries(manifesto)) {
        exigir(typeof hash === 'string' && HASH.test(hash) && (ARQUIVOS_DADOS.some(n => nome === `data/${n}`)
            || /^assets\/(foto|proposta|certidao)\/\d{4}_\d+_[A-Z]{2}_\d+\/[a-f0-9]{64}\.(pdf|jpg|jpeg|png|webp)$/.test(nome)), `entrada proibida no manifesto: ${nome}`);
        if (nome.startsWith('data/')) {
            const buffer = bytes(raiz, nome);
            exigir(sha256(buffer) === hash, `hash divergente: ${nome}`);
            dados[nome.slice(5)] = parse(buffer, nome);
            dadosBytes[nome.slice(5)] = buffer;
        }
    }
    validarDados(dados, manifesto, marcador);
    return { raiz, prefixoPublico, ok: true, status: marcador.status, runId: marcador.runId, versao,
        dados: congelar(dados), controles: congelar({ [CONTROLES[0]]: marcador, [CONTROLES[1]]: manifesto }),
        dadosBytes, marcadorBytes, manifestoBytes };
}

// Importação e build sempre passam pela validação integral, mesmo se runtime/ existir.
export function validarExportacao(raiz, opcoes) {
    const snapshot = validarConteudoSnapshot(raiz, opcoes);
    for (const [nome, hash] of Object.entries(snapshot.controles[CONTROLES[1]])) {
        if (!nome.startsWith('assets/')) continue;
        exigir(sha256(bytes(snapshot.raiz, `${snapshot.prefixoPublico}${nome}`)) === hash, `hash divergente: ${nome}`);
    }
    snapshotsIntegrais.add(snapshot);
    return snapshot;
}

export function carregarSnapshot(raiz = process.cwd()) {
    const pasta = path.join(raiz, 'snapshots');
    const ponteiro = path.join(pasta, 'ativo.json');
    try {
        exigir(!fs.lstatSync(pasta).isSymbolicLink(), 'snapshots não pode ser link');
        exigir(!fs.lstatSync(ponteiro).isSymbolicLink(), 'ponteiro não pode ser link');
    } catch (erro) {
        if (erro.code === 'ENOENT') return validarExportacao(raiz);
        throw erro;
    }
    const ativo = parse(bytes(raiz, 'snapshots/ativo.json'), 'ativo.json');
    exigir(objeto(ativo) && HASH.test(ativo.versao), 'ponteiro inválido');
    const snapshot = validarExportacao(path.join(raiz, 'snapshots', ativo.versao));
    exigir(snapshot.versao === ativo.versao && snapshot.runId === ativo.runId, 'identidade do ponteiro divergente');
    return snapshot;
}
function escrever(destino, buffer) {
    fs.mkdirSync(path.dirname(destino), { recursive: true });
    fs.writeFileSync(destino, buffer, { flag: 'wx' });
}
export function copiarPacote(snapshot, destino) {
    for (const [nome, buffer] of Object.entries(snapshot.dadosBytes)) escrever(path.join(destino, 'data', nome), buffer);
    escrever(path.join(destino, 'public', CONTROLES[0]), snapshot.marcadorBytes);
    escrever(path.join(destino, 'public', CONTROLES[1]), snapshot.manifestoBytes);
    for (const [nome, hash] of Object.entries(snapshot.controles[CONTROLES[1]])) {
        if (!nome.startsWith('assets/')) continue;
        const buffer = bytes(snapshot.raiz, `${snapshot.prefixoPublico}${nome}`);
        exigir(sha256(buffer) === hash, `asset mudou durante cópia: ${nome}`);
        escrever(path.join(destino, 'public', nome), buffer);
    }
}

export function importarExportacao(origem, raiz = process.cwd()) {
    const snapshot = validarExportacao(origem, { layout: 'auto' });
    const pasta = path.join(raiz, 'snapshots');
    fs.mkdirSync(pasta, { recursive: true });
    exigir(!fs.lstatSync(pasta).isSymbolicLink(), 'snapshots não pode ser link');
    const lock = path.join(pasta, '.importacao.lock');
    const fd = fs.openSync(lock, 'wx');
    let temporario;
    let ponteiro;
    try {
        // Inclui o pacote atual no contrato runId -> bytes do manifesto.
        const anteriores = fs.readdirSync(pasta).filter(n => HASH.test(n)).map(n => path.join(pasta, n));
        if (fs.existsSync(path.join(raiz, 'public', CONTROLES[0]))) anteriores.push(raiz);
        for (const anterior of anteriores) {
            const m = parse(bytes(anterior, `public/${CONTROLES[0]}`), CONTROLES[0]);
            const hash = sha256(bytes(anterior, `public/${CONTROLES[1]}`));
            exigir(m.manifestoSHA256 === hash, 'controle anterior corrompido');
            exigir(m.runId !== snapshot.runId || hash === snapshot.versao, `runId já associado a outro manifesto: ${snapshot.runId}`);
        }
        const destino = path.join(pasta, snapshot.versao);
        if (fs.existsSync(destino)) {
            const existente = validarExportacao(destino);
            exigir(existente.runId === snapshot.runId && existente.marcadorBytes.equals(snapshot.marcadorBytes), 'versão existente com marcador diferente');
        } else {
            temporario = fs.mkdtempSync(path.join(pasta, '.importacao-'));
            copiarPacote(snapshot, temporario);
            validarExportacao(temporario);
            fs.renameSync(temporario, destino);
            temporario = undefined;
        }
        ponteiro = path.join(pasta, `.ativo-${randomUUID()}.json`);
        const pfd = fs.openSync(ponteiro, 'wx');
        try {
            fs.writeFileSync(pfd, JSON.stringify({ runId: snapshot.runId, versao: snapshot.versao }) + '\n');
            fs.fsyncSync(pfd);
        } finally { fs.closeSync(pfd); }
        // Mesmo filesystem: nunca remover o ponteiro anterior antes do rename.
        fs.renameSync(ponteiro, path.join(pasta, 'ativo.json'));
        return { ok: true, status: snapshot.status, runId: snapshot.runId, versao: snapshot.versao };
    } finally {
        if (temporario) fs.rmSync(temporario, { recursive: true, force: true });
        if (ponteiro && fs.existsSync(ponteiro)) fs.unlinkSync(ponteiro);
        fs.closeSync(fd);
        fs.unlinkSync(lock);
    }
}
