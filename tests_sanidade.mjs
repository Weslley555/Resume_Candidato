import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { lerJSON, obterFonteSnapshot, verificarExportacao } from './lib/jsonCache.js';
import listaHandler from './api/lista.js';
import candidatoHandler from './api/candidato.js';
import resumoHandler from './api/resumo.js';

// Integração com o pacote real: sem nomes, datas, totais ou candidaturas de teste fixados.
async function chamar(handler, url) {
    const res = {
        headers: {}, statusCode: 200,
        setHeader(k, v) { this.headers[k] = v; },
        status(n) { this.statusCode = n; return this; },
        json(body) { this.body = body; return this; }, end() { return this; },
    };
    await handler({ method: 'GET', url, headers: {} }, res);
    return res;
}
const exportacao = verificarExportacao();
assert.equal(exportacao.ok, true, exportacao.motivo);
const fonte = obterFonteSnapshot();
const publico = JSON.parse(fs.readFileSync('dist/exportacao.json', 'utf8'));
assert.equal(publico.versao, exportacao.versao);
const indiceBytes = fs.readFileSync('dist/' + publico.indice.arquivo);
const indiceBusca = JSON.parse(indiceBytes);
const camposBusca = ['chave', 'nome', 'nomeBusca', 'uf', 'cargo', 'numeroUrna'];
const listaCompactaEsperada = JSON.parse(fonte.lerBytes('lista_busca.json')).map(registro =>
    Object.fromEntries(camposBusca.map(campo => [campo, registro[campo] ?? null])));
assert.equal(createHash('sha256').update(indiceBytes).digest('hex'), publico.indice.sha256);
assert.equal(indiceBusca.exportacao, publico.versao);
assert.deepEqual(indiceBusca.lista, listaCompactaEsperada);
for (const arquivo of ['dados_candidatos.json', 'verificacao_dados.json', 'manifesto_sha256.json', 'EXPORTACAO_VALIDADA.json']) {
    assert.equal(fs.existsSync('dist/' + arquivo), false, arquivo + ' não deve estar na saída pública');
}
const lista = await chamar(listaHandler, '/api/lista');
assert.equal(lista.statusCode, 200);
assert.equal(lista.body.exportacao, publico.versao);
assert.deepEqual(lista.body.lista, lerJSON('lista_busca.json'));
const chave = lista.body.lista[0]?.chave;
assert.ok(chave, 'Pacote precisa conter candidaturas');
const ficha = await chamar(candidatoHandler, '/api/candidato?' + new URLSearchParams({ id: chave, exportacao: publico.versao }));
assert.equal(ficha.statusCode, 200);
assert.equal(ficha.body.chave, chave);
assert.equal(ficha.body.exportacao, publico.versao);
for (const campo of ['candidato', 'patrimonio', 'financeiro', 'documentos', 'foto', 'juridico']) {
    const arquivo = { candidato: 'candidatos', foto: 'fotos' }[campo] ?? campo;
    assert.deepEqual(ficha.body[campo], lerJSON(arquivo + '.json')[chave]);
}
const divergente = await chamar(candidatoHandler, '/api/candidato?' + new URLSearchParams({ id: chave, exportacao: 'versao-antiga' }));
assert.equal(divergente.statusCode, 409);
// Candidatura sem PDF: GET não consulta Gemini nem Redis.
const semPDF = Object.entries(lerJSON('textos_propostas.json')).find(([, docs]) => docs.length === 0)?.[0];
if (semPDF) {
    const resumo = await chamar(resumoHandler, '/api/resumo?' + new URLSearchParams({ id: semPDF, exportacao: publico.versao }));
    assert.equal(resumo.statusCode, 200);
    assert.equal(resumo.body.estado, 'documento_indisponivel');
    assert.equal(resumo.body.chave, semPDF);
    assert.equal(resumo.body.exportacao, publico.versao);
}
console.log('Sanidade integrada aprovada: pacote, build, busca, ficha e indisponibilidade de resumo coerentes.');
