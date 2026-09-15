import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { carregarFonte, prepararContexto, publicarOffline } from '../lib/resumos.js';

// Sem SDK, credenciais, Redis ou acesso à rede. A aprovação é uma declaração humana,
// não uma prova automática de fidelidade semântica. Execute apenas em ambiente confiável.
// Procedimento: conferir o rascunho nos PDFs, executar com as confirmações explícitas
// e incluir o artefato no deploy no caminho informado. Não alterar o manifesto.
// A fonte é a mesma versão fixada para a API; um rascunho de outro snapshot é recusado.
export function revisar(args, { carregar = carregarFonte, ler = fs.readFileSync, escrever = fs.writeFileSync } = {}) {
    const [entrada, saida, revisor, ...flags] = args;
    const obrigatorias = ['--aprovar', '--conferi-neutralidade', '--conferi-referencias', '--conferi-cobertura'];
    const permitidas = [...obrigatorias, '--conferi-ocr'];
    if (!entrada || !saida || !revisor?.trim() || obrigatorias.some(f => !flags.includes(f)) || flags.some(f => !permitidas.includes(f))) {
        throw new Error('Uso: node scripts/revisar-resumo.mjs entrada.json saida.json "Revisor" --aprovar --conferi-neutralidade --conferi-referencias --conferi-cobertura [--conferi-ocr]');
    }
    const registro = JSON.parse(ler(entrada, 'utf8'));
    const fonte = carregar();
    const ctx = prepararContexto(fonte, registro.chave, registro.documentosSelecionados);
    if (ctx.resposta) throw new Error('Documento indisponível ou extração incompleta; publicação bloqueada.');
    const publicado = publicarOffline(registro, ctx, {
        aprovado: true, revisor, neutralidadeConferida: true, referenciasConferidas: true,
        coberturaConferida: true, ocrConferido: flags.includes('--conferi-ocr'),
    });
    // wx recusa sobrescrever rascunhos, artefatos e links já existentes.
    escrever(saida, JSON.stringify(publicado, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    return 'Artefato revisado criado. Para publicar, inclua-o em um deploy confiável como data/resumos_publicados/'
        + publicado.cacheKey.split(':').at(-1) + '.json. Não altere o manifesto da exportação para incluir resumos.';
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try { console.log(revisar(process.argv.slice(2))); }
    catch (erro) { console.error(erro.message); process.exitCode = 1; }
}
