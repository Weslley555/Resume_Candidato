import { lerJSON, buscarPorChave, ehChaveCanonica, resolverAliasLegado, verificarExportacao, lerJSONPublico } from './lib/jsonCache.js';

let erros = 0;
function ok(nome, cond, detalhe = '') {
    if (cond) { console.log(`  ✅ ${nome}`); }
    else       { console.error(`  ❌ ${nome}${detalhe ? ' — ' + detalhe : ''}`); erros++; }
}

// 1. ehChaveCanonica
ok('Canônica BR',   ehChaveCanonica('2026_6257_BR_280002538811'));
ok('Canônica MG',   ehChaveCanonica('2026_6259_MG_130002539775'));
ok('Legado BR=false', !ehChaveCanonica('BR_280002538811'));
ok('null=false',      !ehChaveCanonica(null));

// 2. resolverAliasLegado
const chave = resolverAliasLegado('BR_280002538811');
ok('Alias BR resolve', chave === '2026_6257_BR_280002538811', chave);
ok('Inventado=null',  resolverAliasLegado('CHAVE_INVENTADA_999') === null);

// 3. buscarPorChave — candidatos
const candidatos = lerJSON('candidatos.json');
const cand = buscarPorChave(candidatos, '2026_6257_BR_280002538811');
ok('Candidato encontrado', cand !== null);
ok('candidato.chave correto', cand?.chave === '2026_6257_BR_280002538811', cand?.chave);

// 4. Patrimônio — campos novos
const patrimonio = lerJSON('patrimonio.json');
const patr = buscarPorChave(patrimonio, '2026_6257_BR_280002538811');
ok('Patrimônio encontrado', patr !== null);
ok('totalCentavos é string', typeof patr?.totalCentavos === 'string', typeof patr?.totalCentavos);
ok('DS_TIPO_BEM_CANDIDATO existe', patr?.bens?.[0]?.DS_TIPO_BEM_CANDIDATO !== undefined);
ok('valorCentavos existe',         patr?.bens?.[0]?.valorCentavos !== undefined);

// 5. Financeiro — campos de status
const financeiroDb = lerJSON('financeiro.json');
const fin = buscarPorChave(financeiroDb, '2026_6257_BR_280002538811');
ok('Financeiro encontrado', fin !== null);
ok('status_receitas existe',            'status_receitas'            in (fin ?? {}));
ok('total_arrecadado_centavos existe',  'total_arrecadado_centavos'  in (fin ?? {}));
ok('limite_gastos_centavos existe',     'limite_gastos_centavos'     in (fin ?? {}));
ok('status zero != sem_registros',      fin?.status_receitas === 'sem_registros' || fin?.total_arrecadado_centavos !== 0);

// 6. Fotos — caminho relativo correto
const fotos = lerJSON('fotos.json');
const foto = buscarPorChave(fotos, '2026_6257_BR_280002538811');
ok('Foto encontrada', foto !== null);
ok('Foto começa com assets/', foto?.arquivo?.startsWith('assets/'), foto?.arquivo);

// 7. Verificação do pacote exportado
const exp = verificarExportacao();
ok('Exportação OK', exp.ok === true, JSON.stringify(exp));

// 8. Metadados sem _meta
const meta = lerJSON('metadados.json');
ok('geradoEm em metadados', meta?.geradoEm !== undefined);
ok('schemaVersion 3.0',     meta?.schemaVersion === '3.0', meta?.schemaVersion);

// 9. lista_busca.json em public tem campo 'chave'
const lb = lerJSONPublico('../public/lista_busca.json');
ok('lista_busca.json em public é array', Array.isArray(lb), typeof lb);
ok('Entrada tem chave canônica', ehChaveCanonica(lb?.[0]?.chave), lb?.[0]?.chave);
ok('Entrada tem nomeBusca',      typeof lb?.[0]?.nomeBusca === 'string');

// 10. BigInt centavos (mock do frontend)
const centavosStr = patr?.totalCentavos;
try {
    const n = BigInt(centavosStr);
    const reais = n / 100n;
    const cents = n % 100n;
    ok('BigInt centavos parseia', true, `${reais},${String(cents).padStart(2,'0')}`);
} catch(e) {
    ok('BigInt centavos parseia', false, String(e));
}

// 11. Mesmo SQ em eleições diferentes não confunde
const ch1 = resolverAliasLegado('BR_280002538811');
ok('Não retorna candidatura errada', ch1 === null || ch1.includes('BR_280002538811'));

console.log(`\n${erros === 0 ? '✅ Todos os testes passaram' : `❌ ${erros} falha(s)`}`);
process.exit(erros > 0 ? 1 : 0);
