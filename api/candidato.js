import { lerJSON, buscarPorChave } from '../lib/jsonCache.js';

export default async function handler(req, res) {
    // CORS
    res.setHeader('Access-Control-Allow-Credentials', true);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'OPTIONS,GET');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'GET') return res.status(405).json({ erro: 'Método não permitido.' });

    // Parâmetro: id no format "UF_SQ_CANDIDATO" (ex: "MG_280001234567")
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const id = url.searchParams.get('id');

    if (!id || !id.includes('_')) {
        return res.status(400).json({ erro: 'Parâmetro \"id\" é obrigatório e deve seguir o formato UF_SQ_CANDIDATO.' });
    }

    // Carrega todos os bancos (com cache em memória — leitura síncrona aceitável para cold start)
    const patrimonioDb  = lerJSON('patrimonio.json');
    const financeiroDb  = lerJSON('financeiro.json');
    const documentosDb  = lerJSON('documentos.json');
    const fotosDb       = lerJSON('fotos.json');
    const candidatosDb  = lerJSON('candidatos.json');
    const juridicoDb    = lerJSON('juridico.json');

    // Busca direta por chave — sem percorrer arrays
    const patrimonio  = buscarPorChave(patrimonioDb,  id);
    const financeiro  = buscarPorChave(financeiroDb,  id);
    const documentos  = buscarPorChave(documentosDb,  id);
    const foto        = buscarPorChave(fotosDb,        id);
    const candidato   = buscarPorChave(candidatosDb,   id);
    const juridico    = buscarPorChave(juridicoDb,      id);

    return res.status(200).json({
        id,
        patrimonio:  patrimonio  ?? null,
        financeiro:  financeiro  ?? null,
        documentos:  documentos  ?? null,
        foto:        foto        ?? null,
        candidato:   candidato   ?? null,
        juridico:    juridico    ?? null,
    });
}