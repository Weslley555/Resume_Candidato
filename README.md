# Resume Candidato 2026 — em desenvolvimento

🔗 **Site:** [Resume Candidato](https://resume-candidato.vercel.app/)

## Visão e objetivo

Plataforma de transparência eleitoral para facilitar a consulta a candidaturas, patrimônio declarado, informações financeiras e documentos eleitorais, com apoio de IA na leitura de propostas de governo. O objetivo é tornar os dados acessíveis sem substituir as fontes oficiais, a leitura dos documentos ou a análise humana.

O recorte originalmente apresentado é o das eleições de 2026 em Minas Gerais e da Presidência do Brasil. A cobertura efetivamente disponível, as datas de coleta e os estados dos dados devem ser consultados nos metadados da exportação ativa; não há atualização em tempo real. Os dados são declaratórios e sujeitos a retificações do TSE. **O projeto não é fonte oficial nem recomenda candidaturas.**

Este README descreve o projeto local e sua operação, não comprova que o site publicado já executa esta versão.

## Funcionalidades e uso

1. Busque uma candidatura por nome ou número, filtre por UF/cargo e abra sua ficha.
2. Consulte cadastro e situação eleitoral, informações financeiras e bens declarados, respeitando as indicações de fonte ausente, ausência de registros e valor não informado.
3. Abra fotos, planos de governo e certidões pelos vínculos da exportação. Certidões aparecem em seção expansível com contagem.
4. Consulte o estado do resumo e eventuais resumos publicados. Quando a geração estiver habilitada e a extração for elegível, selecione os PDFs para solicitar um **rascunho não revisado**.
5. Confira as referências às páginas originais e reporte divergências pelo [formulário do projeto](https://forms.gle/TuFSsPBaY6XFYcrq7).

A interface estática oferece temas claro/escuro e apresentação responsiva. Os ajustes locais de interface incluem retirada de gênero/cor/raça da exibição cadastral, financeiro antes dos bens, cinco bens iniciais com opção de ver todos, certidões expansíveis e melhorias de contraste nos links. A retirada de campos da apresentação não altera a fonte exportada nem deve ser interpretada como anonimização da API.

O resumo destaca **somente propostas, agrupadas por tema**: Economia, Saúde, Segurança, Meio Ambiente, Educação, Infraestrutura, Habitação, Assistência Social, Gestão Pública e Outros. Diagnósticos, críticas e realizações alegadas não devem ser apresentados como propostas futuras. O backend usa o contrato v2 descrito abaixo.

## Arquitetura e tecnologias

| Camada | Tecnologia e responsabilidade |
| --- | --- |
| Interface | HTML, CSS e JavaScript em `public/`, com helpers em `public/frontend-helpers.mjs` |
| API | Node.js, módulos ES e Vercel Serverless Functions em `api/` |
| Dados | Exportações JSON e assets validados por SHA-256; snapshots e runtime privados |
| Importação e build | Scripts Node.js em `scripts/`, validação em `lib/exportacao.js` e `lib/runtimeSnapshot.js` |
| Leitura | `lib/jsonCache.js` e `lib/apiDados.js`, fonte validada e fixada por processo |
| Resumos | Google Gemini via `@google/genai`, regras e validação em `lib/resumos.js` |
| Cache e proteção | Upstash Redis; quotas globais e lock de geração em `lib/limitesResumo.js`, sem IP nesse controle |
| Testes | Runner nativo `node --test`, fixtures e dependências simuladas |

A extração/tratamento de origem ocorre fora do runtime web, em pipeline de dados/notebook; este repositório importa seu pacote validado, não coleta dados do TSE a cada consulta.

```text
Exportação completa (JSONs + fotos/PDFs + controles)
  → importação e validação → snapshots/ + ponteiro ativo
  → build com nova validação
      → dist/       interface, índice público e assets
      → runtime/    dados privados e controles para as APIs
  → consulta da ficha e documentos
  → rascunho IA → revisão humana offline → publicação em deploy confiável
```

## Fontes, estado e limites de interpretação

A fonte do fluxo atual é a exportação de dados e documentos eleitorais do TSE. Consulte o [Portal de Dados Abertos do TSE](https://dadosabertos.tse.jus.br/dataset/?tags=Ano+2026) e as datas declaradas em `metadados.json`. A data de geração do pacote não substitui a data de cada fonte. Não se presume cobertura legislativa da Câmara ou do Senado apenas porque ela constava na apresentação antiga.

A migração local adota chave eleitoral completa, importação integral e separação entre publicação estática e dados privados. Os contratos a seguir preservam rastreabilidade e impedem mistura de versões; validação técnica não certifica veracidade, completude ou aprovação editorial.

**Certidões e registros de cassação não equivalem a condenação nem implicam culpa.** Ausência de registro não comprova ausência de antecedentes. Aplica-se a presunção de inocência (art. 5.º, LVII, CF/88); a consulta não é uma pesquisa abrangente em tribunais.


## Dados e pipeline de importação

### Contrato e fonte canônica

Neste projeto, **`textos_propostas.json` é o nome canônico da nova extração por PDF/página**, conforme a exportação adotada pelo mantenedor. Não é um arquivo de resumos de IA. Não existe fallback para a estrutura textual antiga nem para `propostas.json`.

Os 11 JSONs exigidos são:

| Arquivo em `data/` | Uso |
| --- | --- |
| `candidatos.json` | Cadastro, biografia, situação, resultados por turno e origens |
| `lista_busca.json` | Array de busca com chave completa |
| `financeiro.json` | Receitas, contratadas, parcelas pagas, originários, prestação e estados |
| `patrimonio.json` | Bens, total em centavos, quantidade e estado |
| `juridico.json` | Registros de cassação e ressalva de alcance |
| `documentos.json` | PDFs originais, hashes e vínculos |
| `textos_propostas.json` | PDFs e extração selecionada por página, controles de OCR/revisão |
| `fotos.json` | Caminho da foto, estado e vínculo exportado |
| `aliases_legados.json` | Resolução segura de `UF_SQ` quando inequívoca |
| `metadados.json` | Contrato, escopo, geração e datas das fontes |
| `verificacao_dados.json` | Diagnóstico privado; não é cadastro nem é enviado ao navegador |

Os mapas são indexados por `ANO_ELEICAO_CD_ELEICAO_SG_UF_SQ_CANDIDATO`. `id`/SQ permanece string. Nomes, partido, número de urna e CPF não são chaves de junção. `BR` designa circunscrição nacional, não todas as UFs.

### Importar uma exportação

Não copie arquivos isolados sobre uma versão ativa. Forneça **uma pasta completa de uma única execução**:

```text
validado_<execucao>/
  data/                       # os 11 JSONs da tabela
  assets/
    foto/<chave>/<hash>.<ext>
    certidao/<chave>/<hash>.pdf
    proposta/<chave>/<hash>.pdf
  manifesto_sha256.json
  EXPORTACAO_VALIDADA.json
```

O manifesto deve registrar `data/textos_propostas.json`. Uma renomeação posterior à exportação invalida o pacote se manifesto/marcador não corresponderem; o importador não reescreve hashes, controles ou dados para contornar isso.

Na raiz do projeto:

```sh
npm install
npm run importar-exportacao -- "caminho/da/pasta/validado_execucao"
npm test
npm run build
npm run test:sanidade
```

O importador também aceita o layout de projeto já existente: `data/`, `public/assets/` e ambos os controles em `public/`. Nunca combina os dois layouts.

#### Destinos e ativação

- Importações ficam em `snapshots/<sha256-do-manifesto>/data/` e `snapshots/<sha256-do-manifesto>/public/assets/`, preservando toda a hierarquia.
- Ambos os controles ficam em `snapshots/<hash>/public/`.
- `snapshots/ativo.json` é trocado por rename atômico após validação e cópia completa. A importação possui lock e não remove versões anteriores.
- Sem ponteiro importado, o build valida o pacote existente em `data/` + `public/`; não recorre a arquivos legados alternativos.
- O build **sempre valida novamente a fonte integral**, mesmo que já exista `runtime/` de um build anterior.
- `dist/` é a saída pública: interface, ícones, assets validados, cópia gerada de `lista_busca.json` e `exportacao.json` com a identidade da versão.
- `runtime/` é saída privada para funções: 11 JSONs, controles e recibo de build. Não contém PDFs/fotos. Seus bytes e vínculos são novamente conferidos pelo loader.
- O build usa staging, bloqueio da ativação e rollback do par `dist/runtime`. Não faça build sobre um servidor local em uso; reinicie-o após concluir. Em produção, publique site e funções como um único deploy imutável.

`runtime/` e `dist/` são artefatos gerados, não fontes para edição manual. Um runtime presente e inválido bloqueia o serviço; não aciona fallback. A versão é fixada por processo; atualizar o ponteiro não muda instâncias quentes. Após importar, faça build e reinicie o processo/deploy.

O marcador deve ter status permitido (`VALIDADA_TECNICAMENTE`, `VALIDADO` ou `VALIDADO_COM_AVISOS`). São conferidos seu hash do manifesto, todos os JSONs/assets, identidades, aliases, vínculos e conciliações monetárias aplicáveis. Pacotes incompletos, bloqueados, adulterados ou inconsistentes são recusados. Os estados e avisos exportados continuam relevantes mesmo com validação técnica aprovada.

**SHA-256 detecta alterações; não comprova autenticidade do TSE.** O recibo privado é um artefato do build confiável, não uma assinatura externa. Quem puder alterar todo o deploy também pode alterar os recibos: proteja o pipeline e suas permissões.

#### Dados antigos

`public/dados_candidatos.json` e `public/lista_busca.json` antigos foram preservados, mas não são consumidos nem copiados como fontes para publicação. A busca pública gerada vem de `data/lista_busca.json` da versão validada. Não sirva `public/` diretamente como alternativa ao build: essa pasta ainda contém arquivos históricos. Não há fallback `_meta`, cache offline de ficha ou reaproveitamento automático de resumos antigos.

## Contrato das APIs

Todas as respostas de dados usam `exportacao` = **SHA-256 do manifesto**, não `runId`. `runId` é identificação operacional da execução, disponível no controle exportado e em `dist/exportacao.json`. O frontend compara `dist/exportacao.json` com a busca e passa a versão à ficha/resumo; divergência bloqueia a consulta em vez de misturar versões.

### `GET /api/lista`

Retorna `{ exportacao, lista, metadados }`. `lista` é o array canônico; metadados têm whitelist de escopo, geração e datas declaradas das fontes. Não expõe auditoria ou textos de propostas.

### `GET /api/candidato?id=CHAVE&exportacao=HASH`

Retorna:

```text
{ chave, idLegado, exportacao, metadados,
  candidato, patrimonio, financeiro, documentos, foto, juridico }
```

O parâmetro `id` aceita chave completa ou `UF_SQ` resolvido exclusivamente pelo mapa de aliases. `idLegado` documenta o adaptador; todos os dados são unidos pela chave resolvida. O SQ isolado não é aceito. `exportacao` é opcional para clientes externos antigos, mas obrigatório no fluxo do frontend.

- `400`: ID ausente, malformado ou repetido.
- `404`: candidatura inexistente ou alias ausente/ambíguo.
- `409`: versão solicitada divergente.
- `503`: fonte inválida/indisponível, sem detalhes internos no navegador.
- GET/OPTIONS, CORS sem credenciais, respostas `no-store`.

### `/api/resumo`

- GET consulta estado/cache/publicação, sem gerar: `?id=CHAVE&exportacao=HASH`.
- Para selecionar PDFs no GET, repita `documentos=SHA256` para cada documento.
- POST gera apenas rascunho e aceita `{ chave, exportacao, documentos: [SHA256] }`. O campo legado `id_candidato` pode substituir `chave`.
- PDFs múltiplos sem seleção explícita retornam necessidade de seleção/revisão. A seleção de um subconjunto é identificada na interface; não significa análise de todos os documentos da candidatura.

Saída estruturada inclui `chave`, `exportacao`, `estado`, `documentos`, `documentosSelecionados`, `afirmacoes` e, quando gerado, `cobertura`, `modelo`, `versaoPrompt` e `cacheKey`.

O contrato é `{ tipo: 'proposta', tema, texto, referencias: [{ sha256, pagina }] }`, com `tema` limitado aos dez temas listados em Funcionalidades. A versão de prompt é **`resumos-propostas-temas-v3`**, que invalida o reaproveitamento de resumos do contrato anterior, inclusive os que misturam propostas, diagnósticos, críticas e realizações alegadas. Geração, validação, cache e publicação usam o novo contrato; reclassificar um artefato antigo no frontend não o torna compatível.

Referências precisam corresponder a páginas textuais reais dos PDFs selecionados. A saída é renderizada como texto, nunca HTML recebido. Referências estruturalmente válidas não garantem que o texto seja sustentado pelo documento.

Estados distintos:

- `documento_indisponivel`: nenhum PDF disponível no inventário.
- `extracao_pendente`: páginas/cobertura incompletas.
- `rascunho_gerado`: rascunho completo gerado, ainda **não revisado**.
- `resumo_nao_preparado`: a fonte está apta, mas ainda não existe rascunho compatível.
- `revisao_necessaria`: seleção ou controles da extração precisam de intervenção.
- `processamento_offline_necessario`: o documento excede o limite público e precisa de geração antecipada.
- `resumo_publicado`: artefato revisado incluído em deploy confiável.
- `falha_geracao`: o modelo não produziu saída completa e estruturalmente válida.
- `bloqueio_quota` / `bloqueio_configuracao`: geração impedida por quota ou configuração.
- `erro_geracao`: falha da consulta ou da fonte validada.

Não se usa o texto nativo somado ao OCR: somente `paginas[].texto`. Páginas brancas e visuais revisadas são tratadas conforme controles; entram na cobertura, mas sem texto não fundamentam afirmações. Campos de controle ausentes não autorizam geração. OCR requer revisão antes de publicação; confiança OCR não mede veracidade.

A restrição implementada na **API pública** é uma chamada ao modelo, com um único bloco de até **24.000 bytes**, sem fallback de modelo e sem retry público. Seleções maiores devem seguir para processamento/revisão offline, **sem truncar o documento** para caber no limite. Erro ou timeout não publica resultado parcial.

A CLI offline divide em até 1.000 blocos, valida cada bloco e a cobertura integral e consolida apenas duplicatas textuais exatas, unindo referências. Ela não faz uma segunda síntese livre: repetições semânticas, divergências e suporte documental ainda exigem conferência humana. Página individual acima do limite ou volume superior ao teto operacional exige um plano específico de recuperação/divisão, sem truncamento.

## Geração antecipada, revisão e publicação

1. Planeje sem rede nem escrita:

```sh
npm run gerar-rascunhos -- --dry-run
npm run gerar-rascunhos -- --dry-run --candidaturas=CHAVE --documentos=SHA256,OUTRO_SHA256
```

O relatório distingue extração pendente, alerta OCR, blocos concluídos e chamadas pendentes. Para gerar, selecione candidaturas explicitamente e defina um orçamento que considere também o consumo público observado no provedor:

```sh
npm run gerar-rascunhos -- --candidaturas=CHAVE --documentos=SHA256 --max-chamadas=10 --pausa=4000
```

Checkpoints privados são gravados atomicamente em `checkpoints/rascunhos`, vinculados a candidatura, seleção, snapshot, extração, prompt/modelo, limite e hashes dos blocos. A retomada revalida cada checkpoint e processa somente os pendentes. `429` pausa a fila preservando o progresso; `Retry-After` curto é respeitado. O comando não roda no build e não oferece consumo ilimitado.

Para processar toda a fila com o modelo leve, intervalos entre candidaturas e salvamento automático em `data/resumos_publicados/`, execute:

```sh
npm run gerar-rascunhos:fila
```

O modo de fila diferencia rascunhos gerados de resumos efetivamente salvos, interrompe em caso de quota e pode ser executado novamente para retomar pelos checkpoints. Falhas temporárias `502`, `503`, `504`, timeout, abort e respostas incompletas são repetidas com espera progressiva; `--max-tentativas=N` controla de 1 a 10 tentativas por bloco. `--publicar` salva automaticamente os resultados estruturalmente válidos; `--revisor=NOME` altera o identificador registrado pela automação.

2. Use o `rascunho.json` completo produzido pela CLI (ou um rascunho público curto).
3. Confira semanticamente propostas, temas, repetições/divergências, neutralidade, cobertura e todas as referências contra os PDFs. Validação estrutural automatizada não substitui essa etapa. Em ambiente confiável, execute:

```sh
npm run revisar-resumo -- rascunho.json revisado.json "Nome do revisor" --aprovar --conferi-neutralidade --conferi-referencias --conferi-cobertura
```

Acrescente `--conferi-ocr` quando exigido. A saída usa criação exclusiva: não sobrescreve arquivos.

4. Inclua o artefato no caminho `data/resumos_publicados/<hash-da-cacheKey>.json` informado pelo comando, em um deploy confiável. Não acrescente resumos ao manifesto do notebook nem edite os dados originais.

Não existe endpoint público de aprovação. Redis nunca é autoridade de publicação. Estrutura válida e referências existentes **não provam suporte semântico**: a conferência humana continua indispensável. `aptoParaRascunho` não é aprovação editorial.

O cache de rascunhos tem validade de **7 dias** e considera chave canônica, versão da exportação, inventário/seleção, hashes dos PDFs, hash de toda a extração e controles, prompt e modelo efetivamente usado. Melhorar o OCR invalida a entrada mesmo sem mudar o PDF. Resumos revisados antigos podem ser preservados como histórico, mas não são servidos para outra chave/extração/versão.

## Valores, contagens e interpretação

- Centavos são strings inteiras ou `null`, com cálculos/conciliações em `BigInt`. Nenhum `BigInt` é enviado cru em JSON.
- Zero explícito aparece como zero. `null` nunca vira zero. Limite ausente: “Não informado”.
- `sem_fonte`: “Fonte não disponível”; `sem_registros`: “Sem registros na fonte consultada”; `valor_nao_informado`: “Valor não informado”; `ok`: valor inclusive zero.
- Receitas contam itens; contratadas contam itens; pagamentos contam parcelas. Os conjuntos são mostrados separadamente, preservando repetições na fonte e sem cruzamentos multiplicadores. Originários não são somados novamente às receitas nem contados como doadores únicos.
- Arrecadado menos pago não é saldo bancário; contratado menos pago não é dívida oficial.
- Gênero/cor/raça deixam de ser exibidos no cadastro da interface; campos cadastrais e FEFC são conceitos distintos. Idade possui referência; idade na posse é outro campo. Reeleição não usa coerção de strings em booleanos.
- Datas de geração da exportação, das fontes e da prestação são distintas. Prestação de contas não é julgamento de aprovação.
- Certidão vinculada não equivale a “nada consta”; ausência de cassação na fonte não comprova ausência de antecedentes.
- Fotos ausentes usam placeholder local neutro. PDFs/fotos só usam vínculos exportados e caminhos por chave/hash. A base pública é configurada em `meta[name=public-base]` no HTML.

## Operação, segurança e publicação

### Desenvolvimento local

```sh
npm install
npm test
npm run build
npm run test:sanidade
npx vercel dev
```

Use a saída `dist/`, incluindo `exportacao.json`; abrir `index.html` via `file://` ou servir somente `public/` não oferece as APIs nem o contrato de versão. O comando `vercel dev` pode exigir configuração/autenticação da Vercel. Não foi feito deploy automático.

`vercel.json` publica `dist/` e inclui nas funções somente `runtime/` e resumos revisados. Fotos/PDFs permanecem estáticos para evitar exceder o limite de bundle serverless. O build local não substitui a verificação do bundle e dos limites do plano na Vercel.

### Geração pública: configuração e proteções implementadas

As variáveis abaixo não são necessárias para os testes offline. Para liberar **nova geração pública**, o backend exige opt-in explícito e credenciais Gemini **e Redis**; Redis é obrigatório nesse caminho. A leitura de resumos publicados continua disponível sem habilitar geração.

| Variável | Uso |
| --- | --- |
| `GERACAO_PUBLICA_HABILITADA` | Somente o valor `true` autoriza o opt-in de geração pública |
| `GEMINI_API_KEY` | Credencial obrigatória para gerar com Gemini |
| `KV_REST_API_URL` | URL Redis obrigatória para proteção e cache da geração pública |
| `KV_REST_API_TOKEN` | Credencial Redis com permissão de escrita |

Limites padrão e prazos implementados:

| Controle | Limite |
| --- | --- |
| Orçamento global de geração | 20 tentativas por janela de 24 horas e 2 por janela de 60 segundos |
| Concorrência | Lock de 60 segundos por seleção |
| Volume público | Um bloco de até 24.000 bytes, uma chamada, sem fallback/retry |
| Timeout Gemini | 20 segundos |
| Prazo do cliente | 30 segundos |
| Duração da função | 30 segundos |
| Cache de rascunho | 7 dias |

As quotas são globais no Redis compartilhado, em janelas fixas iniciadas na primeira admissão, e não usam IP na aplicação. Tentativas admitidas consomem quota mesmo se falharem, sem reembolso. O lock por candidatura/seleção permanece por 60 segundos, inclusive após falha; os contadores expiram em 60 segundos e 24 horas. Isso não é proteção universal de todas as rotas. Sem opt-in, credenciais ou Redis operacional, a nova geração fica indisponível; falhas de Redis bloqueiam a geração, com timeout de 1 segundo por operação e sem retry. Respostas de bloqueio usam `429` ou `503` e `Retry-After`. A leitura de publicados não depende da autorização para gerar.

Nunca exponha `.env` ou credenciais no frontend. Geração envia o texto das páginas selecionadas ao Google e pode ter custos e limites de serviço. Redis armazena rascunhos e metadados de proteção/cache. **Operação gratuita não é garantida**: configure também WAF/rate limiting na Vercel e acompanhe quotas, custos, duração e tamanho dos bundles. O arquivo `middleware.js` contém um limitador separado por IP; sua presença não comprova ativação no deploy nem substitui as proteções de geração. Não se presume ausência de logs técnicos dos provedores: coleta e retenção seguem suas políticas.

Conteúdo dos PDFs é entrada não confiável. Instruções de sistema, validação estrutural, referências e renderização textual reduzem riscos, mas não tornam prompt injection impossível nem substituem revisão humana.

## Testes e limitações

`npm test` executa testes de importação/runtime, APIs, frontend e resumo com fixtures temporárias e dependências simuladas. `npm run test:sanidade` verifica o pacote real, bytes do índice público, versão do build e respostas reais dos handlers, sem chamar IA.

Cobertura inclui identidades e aliases ambíguos, mesmo SQ em eleições distintas, nomes/números coincidentes, centavos exatos, null/zero, repetições, originários, assets, seleção de PDFs, OCR/páginas brancas/visuais/pendentes, cobertura, cache invalidado por extração e publicação humana, corrupção de pacote/runtime e rollback.

A suíte offline cobre pré-condições, estados, seleção, checkpoints, retomada, concorrência, orçamento, quota/`Retry-After`, OCR, cobertura/referências, ausência de publicação parcial, temas, publicação de planos extensos e mensagens sem conteúdo. As opções de timeout/retry do SDK são verificadas por código e mocks; isso não substitui uma chamada real ao provedor.

O build local foi tentado, mas bloqueado por `EPERM` ao renomear `dist/` no Windows. Libere o diretório e execute novamente `npm run build` antes de publicar. Não houve validação visual em navegador, chamadas reais ao Gemini/Redis ou deploy. Testes com mocks não comprovam disponibilidade externa nem proteção efetiva no ambiente publicado. Não há medição do bundle final Vercel; confira os limites e a configuração do plano antes de publicar. Históricos `.build-anterior-*` são preservados localmente; podem consumir espaço e não devem ser publicados.

## Licença e contato

Consulte [LICENSE](LICENSE), [Política de Privacidade](PRIVACIDADE.md) e os termos em `public/termos-de-uso.html`. Reporte divergências pelo [formulário do projeto](https://forms.gle/TuFSsPBaY6XFYcrq7).
