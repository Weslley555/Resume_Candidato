import { importarExportacao } from '../lib/exportacao.js';

try {
    if (process.argv.length !== 3) throw new Error('Uso: npm run importar-exportacao -- <pacote com data/ e public/, ou data/, assets/ e controles na raiz>');
    console.log(JSON.stringify(importarExportacao(process.argv[2]), null, 2));
} catch (erro) {
    console.error(`Importação não ativada: ${erro.message}`);
    process.exitCode = 1;
}
