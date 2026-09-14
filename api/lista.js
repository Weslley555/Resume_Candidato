import { dadosPadrao, criarHandlerGET, snapshotValido, indisponivel, metadadosPublicos } from '../lib/apiDados.js';

export function criarHandler(dados = dadosPadrao) {
    return criarHandlerGET((_params, res) => {
        const exportacao = dados.verificarExportacao();
        if (!snapshotValido(exportacao)) return indisponivel(res);
        const lista = dados.lerJSON('lista_busca.json');
        if (!Array.isArray(lista)) return indisponivel(res);
        return res.status(200).json({
            exportacao: exportacao.versao,
            lista,
            metadados: metadadosPublicos(dados.lerJSON('metadados.json')),
        });
    });
}

export default criarHandler();
