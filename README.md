# Resume Candidato 2026 ( Em desenvolvimento )

🔗 **Acesse:** [Resume Candidato 2026](https://resume-candidato.vercel.app/)

Plataforma de transparência eleitoral que permite buscar candidatos das eleições
de 2026 (Minas Gerais e Presidência do Brasil), consultar dossiês com perfil,
patrimônio declarado e gerar resumo do plano de governo por inteligência
artificial (Gemini).

## Stack

| Camada            | Tecnologia                                      |
|-------------------|-------------------------------------------------|
| Frontend          | HTML + CSS + JavaScript (estático em `/public`) |
| Backend / API     | Node.js + Vercel Serverless Functions (`/api`)  |
| Rate limiting     | Upstash Redis (sliding window, 20 req/min por IP) |
| Geração de resumo | Google Gemini (`gemini-3.5-flash`)          |
| Cache de dados    | Módulo `lib/jsonCache.js` (Map em memória)       |
| Processamento de dados | Python (Google Colab), scripts em `Tratamento_Dados/` |

## Estrutura de pastas

```
/
├── api/
│   ├── candidato.js            # Função serverless — dados completos por ID
│   └── resumo.js               # Função serverless — geração de resumo por IA
├── data/                        # Bancos de dados JSON (acesso somente servidor)
│   ├── candidatos.json
│   ├── documentos.json
│   ├── financeiro.json
│   ├── fotos.json
│   ├── patrimonio.json
│   └── textos_propostas.json
├── lib/
│   └── jsonCache.js             # Cache em memória para leituras de /data
├── public/
│   ├── index.html              # Interface principal de busca e dossiê
│   ├── privacidade.html         # Política de privacidade
│   ├── termos-de-uso.html       # Termos de uso e canal de correção
│   ├── script.js               # Lógica do frontend (busca, ficha, chamada à API)
│   ├── style.css                # Estilos (tema escuro e claro responsivos)
│   ├── lista_busca.json         # Índice leve para busca de candidatos
│   └── dados_candidatos.json    # Dossiês completos (lazy load — legado)
├── Tratamento_Dados/            # Scripts Python/Colab de extração e tratamento do TSE
├── middleware.js.bak            # Rate limiting por IP (Upstash Redis — veja Problemas)
├── vercel.json                  # Rewrites (ex: /privacidade → /privacidade.html)
├── package.json
├── LICENSE                      # AGPL-3.0
└── README.md
```

> **Nota:** `Tratamento_Dados/` utiliza Python (Google Colab) e é a exceção à
> stack principal do projeto, que é inteiramente Node.js + HTML/CSS/JS estático.

## Segurança

### XSS — Sanitização de dados

Todos os dados de candidatos exibidos na interface (nome, partido, cargo, bens,
certidões etc.) passam por sanitização via `textContent` antes de serem
inseridos no DOM. A função `escaparHTML()` em `script.js` garante que nenhum
dado externo — mesmo vindo de fontes oficiais como o TSE — possa ser
interpretado como HTML malicioso.

### Prompt Injection — Resumo por IA

O texto das propostas de governo (conteúdo não confiável, enviado pelo próprio
candidato ao TSE) é sanitizado antes de ser enviado ao Gemini: marcadores `###`
são substituídos por `[DELIM]`, impedindo que o conteúdo quebre os
delimitadores do prompt e injete instruções no modelo. Além disso, o prompt
orienta o modelo a atuar exclusivamente na extração objetiva de políticas públicas
em tópicos essenciais (Saúde, Educação, Economia, Segurança).

### Rate limiting

Todas as rotas `/api` são protegidas por rate limiting via Upstash Redis (20
requisições por minuto por IP). Veja a seção **Problemas conhecidos** para
detalhes sobre o middleware no ambiente local.

## Fontes de dados

Todos os dados exibidos são provenientes de **fontes públicas oficiais**,
coletados em **04 de setembro de 2026**:

| Fonte                                 | Tipo de dado                                          |
|---------------------------------------|-------------------------------------------------------|
| **TSE** — Tribunal Superior Eleitoral | Cadastro de candidatos, bens declarados, situação     |
| **Câmara dos Deputados**              | Proposições legislativas, votações, mandatos          |
| **Senado Federal**                    | Atividade legislativa, mandatos                       |

📦 **Bases de dados originais:** [Conjunto de dados — Portal de Dados Abertos do TSE](https://dadosabertos.tse.jus.br/dataset/?tags=Ano+2026)

O projeto **não realiza atualização em tempo real** — os dados refletem o
estado das bases públicas na data de coleta.

### 📢 Canal de reporte e correção de erros

Para assegurar a confiabilidade dos dados e transparência com a sociedade civil:
- **Formulário oficial de reporte:** [Google Forms](https://forms.gle/TuFSsPBaY6XFYcrq7)
- **Botão flutuante**: Acesso rápido fixo no canto inferior direito em todas as páginas (`#btnReportarErroFlutuante`).
- **Botão dedicado na ficha**: Ao final do dossiê de cada candidato, há um botão em destaque para reportar inconsistências específicas daquele perfil.

### 🛡️ Rastreabilidade e disclaimers colapsáveis

- **Disclaimers colapsáveis de fonte**: Cada card exibe a identificação de extração do TSE (`04/09/2026`) em formato colapsável (`<details>/<summary>`), permitindo expandir a ressalva de retificação contínua e o link direto para a fonte oficial sem sobrecarregar a interface.
- **Avisos permanentes**: O banner superior e o aviso legal de presunção de inocência no rodapé permanecem sempre visíveis e de alto contraste em ambos os temas (escuro e claro).

## 🐛 Problemas conhecidos

### `middleware.js` bloqueando requisições em localhost

O `middleware.js` é responsável pelo rate limiting por IP via Upstash Redis —
impedindo abusos e controlando o volume de chamadas à API do Gemini em produção.
Ao subir o deploy na Vercel, **não apresenta erro algum**, porém em ambiente
**localhost** ele intercepta e bloqueia as requisições de resumo do Gemini.

> **Solução para testes locais:** renomeie o arquivo para `middleware.js.bak`
> enquanto estiver desenvolvendo localmente. Lembre-se de restaurar o nome
> original antes de fazer deploy.

---

## ⚠️ Nota metodológica — Registros criminais e cassações

Campos como **"certidão criminal"** ou **"motivo de cassação"** indicam
**registros constantes nas bases de dados públicas** no momento da coleta.
Eles **não** representam condenações definitivas nem implicam culpa.

A interpretação correta é sempre: *"consta registro nas bases públicas"* —
**nunca** *"crime cometido"*. O Brasil adota o princípio constitucional da
**presunção de inocência** (art. 5.º, LVII, CF/88). Este projeto respeita
integralmente esse princípio.

## 🧭 Como usar o site

1. **Acesse** [radar-eleitoral-2026](https://resume-candidato.vercel.app/) pelo navegador.
2. **Busque um candidato** pelo nome ou partido no campo de pesquisa da página inicial.
3. **Selecione o candidato** na lista de resultados para abrir o dossiê completo.
4. No dossiê você encontrará:
   - Informações cadastrais (partido, cargo, estado, situação da candidatura)
   - Patrimônio declarado ao TSE
   - Histórico legislativo (quando disponível)
   - Certidões e registros constantes nas bases públicas
5. Clique em **"Resumir Plano de Governo"** para acionar a IA (Gemini) e obter
   um resumo automático das propostas do candidato.
6. Caso identifique qualquer dado divergente ou desatualizado, utilize o botão
   **"Reportar erro"** (flutuante no canto inferior ou no rodapé do dossiê)
   para enviar um relato detalhado pelo formulário oficial.

> **Observação:** O resumo por IA está sujeito ao rate limit de 02 requisições
> por minuto por IP em produção.

---

## Como rodar localmente

1. Clone o repositório e instale as dependências:
   ```bash
   npm install
   ```

2. Configure as variáveis de ambiente (crie um arquivo `.env` na raiz):
   ```
   GEMINI_API_KEY=
   KV_REST_API_URL=
   KV_REST_API_TOKEN=
   ```
   > Os valores devem ser preenchidos com suas credenciais. **Nunca comite
   > o `.env`** — ele já está listado no `.gitignore`.

3. Inicie o servidor de desenvolvimento:
   ```bash
   npx vercel dev
   ```

4. Acesse `http://localhost:3000` no navegador.

## Variáveis de ambiente necessárias

| Variável                     | Uso                                      |
|------------------------------|------------------------------------------|
| `GEMINI_API_KEY`             | Autenticação com a API do Google Gemini  |
| `KV_REST_API_URL`            | URL REST do Upstash Redis (rate limiting) |
| `KV_REST_API_TOKEN`          | Token de acesso completo do Upstash Redis (requer escrita) |

> Certifique-se de que essas mesmas variáveis estão configuradas em
> **Vercel > Settings > Environment Variables** para o ambiente de produção.

## Licença

Este projeto é licenciado sob a **GNU Affero General Public License v3.0
(AGPL-3.0)**. Consulte o arquivo [`LICENSE`](./LICENSE) para os termos
completos.
