import {
    lerJSON,
    buscarPorChave,
    ehChaveCanonica,
    resolverAliasLegado,
    verificarExportacao,
} from '../lib/jsonCache.js';

export default async function handler(req, res) {
    // CORS
    res.setHeader('Access-Control-Allow-Credentials', true);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'OPTIONS,GET');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'GET') return res.status(405).json({ erro: 'Método não permitido.' });

    // Parâmetro 'id': aceita a chave canônica (ANO_CD_UF_SQ) ou o formato legado (UF_SQ).
    // A chave canônica tem exatamente 4 segmentos separados por '_'.
    // O formato legado (UF_SQ) é resolvido via aliases_legados.json.
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const idParam = url.searchParams.get('id');

    if (!idParam || !idParam.includes('_')) {
        return res.status(400).json({
            erro: 'Parâmetro "id" é obrigatório no formato ANO_ELEICAO_CD_ELEICAO_SG_UF_SQ_CANDIDATO.',
        });
    }

    // Verificação do pacote de exportação — rejeita se bloqueado ou incompleto
    const exportacao = verificarExportacao();
    if (!exportacao.ok) {
        return res.status(503).json({ erro: exportacao.motivo });
    }

    // Resolve a chave canônica
    let chave;
    if (ehChaveCanonica(idParam)) {
        chave = idParam;
    } else {
        // Tenta resolver via aliases_legados.json (formato legado UF_SQ)
        const resolvida = resolverAliasLegado(idParam);
        if (!resolvida) {
            return res.status(404).json({
                erro: 'Identificador não encontrado ou ambíguo. Use a chave canônica ANO_ELEICAO_CD_ELEICAO_SG_UF_SQ_CANDIDATO.',
                idRecebido: idParam,
            });
        }
        chave = resolvida;
    }

    // Carrega bancos de dados com cache em memória
    const candidatosDb  = lerJSON('candidatos.json');
    const patrimonioDb  = lerJSON('patrimonio.json');
    const financeiroDb  = lerJSON('financeiro.json');
    const documentosDb  = lerJSON('documentos.json');
    const fotosDb       = lerJSON('fotos.json');
    const juridicoDb    = lerJSON('juridico.json');
    // metadados.json substitui o campo _meta que existia nos arquivos de dados anteriores.
    // Expõe apenas os campos públicos (geradoEm, escopo, status); nunca expõe verificacao_dados.json.
    const metadadosDb   = lerJSON('metadados.json');

    // Busca direta por chave canônica — sem percorrer arrays
    const candidato  = buscarPorChave(candidatosDb,  chave);

    if (!candidato) {
        return res.status(404).json({ erro: 'Candidato não encontrado.', chave });
    }

    const patrimonio = buscarPorChave(patrimonioDb, chave);
    const financeiro = buscarPorChave(financeiroDb, chave);
    const documentos = buscarPorChave(documentosDb, chave);
    const foto       = buscarPorChave(fotosDb,      chave);
    const juridico   = buscarPorChave(juridicoDb,   chave);

    // Resumo de metadados exposto publicamente — nunca inclui detalhes de auditoria interna
    const metaPublico = metadadosDb ? {
        geradoEm:        metadadosDb.geradoEm        ?? null,
        schemaVersion:   metadadosDb.schemaVersion    ?? null,
        escopo:          metadadosDb.escopo           ?? null,
        status:          metadadosDb.status           ?? null,
        idadeReferencia: metadadosDb.idadeReferencia  ?? null,
        exportacaoRunId: exportacao.runId             ?? null,
    } : null;

    return res.status(200).json({
        // 'chave' é o identificador canônico — use-o em cache, favoritos e junções
        chave,
        // 'idLegado' preenchido apenas quando o cliente enviou o formato antigo (UF_SQ)
        // — adaptador explícito para manter compatibilidade sem silenciar a migração
        idLegado:   ehChaveCanonica(idParam) ? null : idParam,
        metadados:  metaPublico,
        candidato,
        patrimonio:  patrimonio ?? null,
        financeiro:  financeiro ?? null,
        documentos:  documentos ?? null,
        foto:        foto       ?? null,
        juridico:    juridico   ?? null,
    });
}