import fs from 'fs';
import path from 'path';

// Helper: lê e parseia um JSON de /data sem lançar exceção — retorna null em caso de falha
function lerJSON(nomeArquivo) {
    try {
        const filePath = path.join(process.cwd(), 'data', nomeArquivo);
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
        return null;
    }
}

// Helper: busca uma chave com acesso direto
function buscarPorChave(db, id) {
    if (!db || !id) return null;
    return db[id] ?? null;
}

export default async function handler(req, res) {
    // CORS
    res.setHeader('Access-Control-Allow-Credentials', true);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'OPTIONS,GET');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'GET') return res.status(405).json({ erro: 'Método não permitido.' });

    // Parâmetro: id no formato "UF_SQ_CANDIDATO" (ex: "MG_280001234567")
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const id = url.searchParams.get('id');

    if (!id || !id.includes('_')) {
        return res.status(400).json({ erro: 'Parâmetro "id" é obrigatório e deve seguir o formato UF_SQ_CANDIDATO.' });
    }

    // Carrega todos os bancos (leitura síncrona em serverless — aceitável para cold start)
    const patrimonioDb  = lerJSON('patrimonio.json');
    const financeiroDb  = lerJSON('financeiro.json');
    const documentosDb  = lerJSON('documentos.json');
    const fotosDb       = lerJSON('fotos.json');
    const candidatosDb  = lerJSON('candidatos.json');

    // Busca direta por chave — sem percorrer arrays
    const patrimonio  = buscarPorChave(patrimonioDb,  id);
    const financeiro  = buscarPorChave(financeiroDb,  id);
    const documentos  = buscarPorChave(documentosDb,  id);
    const foto        = buscarPorChave(fotosDb,        id);
    const candidato   = buscarPorChave(candidatosDb,   id);

    return res.status(200).json({
        id,
        patrimonio:  patrimonio  ?? null,
        financeiro:  financeiro  ?? null,
        documentos:  documentos  ?? null,
        foto:        foto        ?? null,
        candidato:   candidato   ?? null,
    });
}
