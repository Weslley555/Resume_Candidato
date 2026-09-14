import {
    dadosPadrao, criarHandlerGET, snapshotValido, indisponivel, metadadosPublicos,
    ehChaveCanonica, buscarPorChave,
} from '../lib/apiDados.js';

const CONJUNTOS_FINANCEIROS = new Set(['prestadores', 'receitas', 'despesasContratadas', 'pagamentos', 'doadoresOriginarios']);
const LIMITE_MAXIMO = 100;
const CAMPOS_CADASTRO = [
    'chave', 'id', 'anoEleicao', 'codigoEleicao', 'uf', 'numeroUrna', 'nomeUrna', 'nomeCompleto',
    'cargo', 'partido', 'situacaoCandidatura', 'instrucao', 'ocupacao', 'tentandoReeleicao',
    'situacaoPrestacaoContas', 'statusJulgamento', 'situacaoUrna', 'nrProcesso',
    'situacaoDiploma', 'situacaoEleitoral', 'situacaoCassacao',
];
function selecionar(objeto, campos) {
    return Object.fromEntries(campos.filter(campo => Object.hasOwn(objeto ?? {}, campo)).map(campo => [campo, objeto[campo]]));
}
function parametroUnico(params, nome) {
    const valores = params.getAll(nome);
    if (valores.length > 1) throw Object.assign(new Error(`Informe no máximo um "${nome}".`), { statusCode: 400 });
    return valores[0] ?? null;
}
function pagina(params) {
    const rawPagina = parametroUnico(params, 'pagina') ?? '1';
    const rawLimite = parametroUnico(params, 'limite') ?? '25';
    if (!/^[1-9]\d{0,5}$/.test(rawPagina) || !/^[1-9]\d{0,2}$/.test(rawLimite)
        || Number(rawLimite) > LIMITE_MAXIMO) {
        throw Object.assign(new Error(`"pagina" deve ser positiva e "limite" deve estar entre 1 e ${LIMITE_MAXIMO}.`), { statusCode: 400 });
    }
    return { pagina: Number(rawPagina), limite: Number(rawLimite) };
}
function paginar(itens, numero, limite) {
    const total = itens.length, inicio = (numero - 1) * limite;
    return { pagina: numero, limite, total, temMais: inicio + limite < total, itens: itens.slice(inicio, inicio + limite) };
}

export function criarHandler(dados = dadosPadrao) {
    return criarHandlerGET((params, res) => {
        const ids = params.getAll('id');
        const id = ids[0];
        const canonico = ehChaveCanonica(id);
        if (ids.length !== 1 || (!canonico && !/^[A-Z]{2}_\d+$/.test(id))) {
            return res.status(400).json({ erro: 'Informe um único "id" no formato ANO_CD_UF_SQ ou UF_SQ.' });
        }
        const versoes = params.getAll('exportacao');
        if (versoes.length > 1) {
            return res.status(400).json({ erro: 'Informe no máximo uma "exportacao".' });
        }
        const exportacao = dados.verificarExportacao();
        if (!snapshotValido(exportacao)) return indisponivel(res);
        if (versoes.length === 1 && versoes[0] !== exportacao.versao) {
            return res.status(409).json({ erro: 'A exportação mudou. Atualize a lista de candidatos.', exportacao: exportacao.versao });
        }

        // UF_SQ só é aceito por uma entrada unívoca do mapa; nunca por busca de SQ.
        const chave = canonico ? id : buscarPorChave(dados.lerJSON('aliases_legados.json'), id);
        if (!ehChaveCanonica(chave)) {
            return res.status(404).json({ erro: 'Identificador não encontrado ou ambíguo. Use a chave canônica.' });
        }
        const candidato = buscarPorChave(dados.lerJSON('candidatos.json'), chave);
        if (candidato === null) return res.status(404).json({ erro: 'Candidato não encontrado.' });
        const modo = parametroUnico(params, 'modo');
        const secao = parametroUnico(params, 'secao');
        const envelope = { chave, idLegado: canonico ? null : id, exportacao: exportacao.versao };

        if (secao) {
            if (modo) return res.status(400).json({ erro: 'Não combine "modo" e "secao".' });
            if (secao === 'cadastro') return res.status(200).json({ ...envelope, secao, candidato });
            if (secao === 'juridico') return res.status(200).json({ ...envelope, secao,
                juridico: buscarPorChave(dados.lerJSON('juridico.json'), chave) });
            const { pagina: numero, limite } = pagina(params);
            if (secao === 'patrimonio') {
                const patrimonio = buscarPorChave(dados.lerJSON('patrimonio.json'), chave);
                return res.status(200).json({ ...envelope, secao, ...paginar(Array.isArray(patrimonio?.bens) ? patrimonio.bens : [], numero, limite) });
            }
            if (secao === 'financeiro') {
                const conjunto = parametroUnico(params, 'conjunto');
                if (!CONJUNTOS_FINANCEIROS.has(conjunto)) return res.status(400).json({ erro: 'Conjunto financeiro inválido.' });
                const financeiro = buscarPorChave(dados.lerJSON('financeiro.json'), chave);
                return res.status(200).json({ ...envelope, secao, conjunto,
                    ...paginar(Array.isArray(financeiro?.[conjunto]) ? financeiro[conjunto] : [], numero, limite) });
            }
            return res.status(400).json({ erro: 'Seção inválida.' });
        }

        const patrimonio = buscarPorChave(dados.lerJSON('patrimonio.json'), chave);
        const financeiro = buscarPorChave(dados.lerJSON('financeiro.json'), chave);
        if (modo === 'compacto') {
            const bens = Array.isArray(patrimonio?.bens) ? [...patrimonio.bens] : [];
            bens.sort((a, b) => {
                const x = typeof a?.valorCentavos === 'string' && /^-?\d+$/.test(a.valorCentavos) ? BigInt(a.valorCentavos) : null;
                const y = typeof b?.valorCentavos === 'string' && /^-?\d+$/.test(b.valorCentavos) ? BigInt(b.valorCentavos) : null;
                return x === null ? (y === null ? 0 : 1) : y === null ? -1 : x === y ? 0 : x > y ? -1 : 1;
            });
            const resumoFinanceiro = Object.fromEntries(Object.entries(financeiro ?? {}).filter(([, valor]) => !Array.isArray(valor)));
            resumoFinanceiro.contagens = Object.fromEntries([...CONJUNTOS_FINANCEIROS].map(nome => [nome,
                Array.isArray(financeiro?.[nome]) ? financeiro[nome].length : null]));
            return res.status(200).json({ ...envelope,
                metadados: metadadosPublicos(dados.lerJSON('metadados.json')),
                candidato: selecionar(candidato, CAMPOS_CADASTRO),
                patrimonio: { ...Object.fromEntries(Object.entries(patrimonio ?? {}).filter(([, valor]) => !Array.isArray(valor))),
                    topBens: bens.slice(0, 5) },
                financeiro: resumoFinanceiro,
                documentos: buscarPorChave(dados.lerJSON('documentos.json'), chave),
                foto: buscarPorChave(dados.lerJSON('fotos.json'), chave),
            });
        }
        if (modo !== null) return res.status(400).json({ erro: 'Modo inválido.' });

        return res.status(200).json({ ...envelope,
            metadados: metadadosPublicos(dados.lerJSON('metadados.json')),
            candidato, patrimonio, financeiro,
            documentos: buscarPorChave(dados.lerJSON('documentos.json'), chave),
            foto: buscarPorChave(dados.lerJSON('fotos.json'), chave),
            juridico: buscarPorChave(dados.lerJSON('juridico.json'), chave),
        });
    });
}

export default criarHandler();
