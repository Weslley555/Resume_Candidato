# Política de Privacidade — Resume Candidato 2026

> **Última atualização:** 14 de setembro de 2026

---

## 1. Visão Geral

O **Resume Candidato 2026** é uma ferramenta de consulta pública de dados eleitorais.
Esta política descreve de forma transparente quais dados são (e **não são**) coletados
ou processados ao utilizar o site.

---

## 2. O que este site NÃO faz

- **Não cria contas de usuário** — nenhum cadastro, login ou perfil é necessário ou armazenado.
- **Não utiliza cookies de rastreamento** — nenhum cookie analítico, publicitário ou de sessão
  é gravado no seu navegador.
- **Não armazena histórico de buscas na aplicação** — os termos digitados para filtrar a lista
  são processados localmente no navegador. Consultas a fichas, documentos e resumos geram
  requisições aos serviços; isso é distinto de manter um histórico de buscas.

---

## 3. Proteção da geração, processamento e retenção

A nova proteção de geração de resumos utiliza **quotas globais e lock no Redis**, sem
usar ou armazenar o IP do visitante nesse controle da aplicação.

- As quotas permitem 20 tentativas por janela de 24 horas e 2 por janela de 60 segundos,
  compartilhadas entre visitantes. Os contadores expiram em **24 horas** e **60 segundos**,
  respectivamente; as janelas começam na primeira admissão.
- O lock por candidatura e seleção de documentos expira em **60 segundos**. Tentativas
  admitidas consomem quota mesmo se falharem; não há identificação por visitante nesses registros.
- Para gerar um resumo, o texto das páginas selecionadas dos documentos públicos é enviado
  ao **Google Gemini**. Os rascunhos e seus metadados são armazenados em cache no Redis
  por **7 dias**. Esses prazos são os TTLs configurados na aplicação, não prazos de retenção
  dos provedores.

O repositório também contém um limitador separado por IP em `middleware.js`; sua presença
não comprova que esteja ativo no ambiente publicado. Não se afirma ausência de processamento
de IP em toda a aplicação ou infraestrutura. Provedores de hospedagem, Redis e IA podem
manter logs técnicos, inclusive dados de conexão quando aplicável, conforme suas próprias
políticas. Esta política não estabelece prazos de coleta ou retenção não verificados nesses serviços.

---

## 4. Origem dos Dados dos Candidatos

Todos os dados exibidos sobre os candidatos são provenientes de **fontes públicas oficiais**:

| Fonte | Dado |
|---|---|
| **TSE** — Tribunal Superior Eleitoral | Cadastro de candidatos, bens declarados, situação de candidatura |
| **Câmara dos Deputados** | Proposições legislativas, votações, mandatos |
| **Senado Federal** | Atividade legislativa, mandatos |

Os dados foram coletados em **04 de setembro de 2026** e refletem o estado das bases
públicas nessa data. O projeto não realiza atualização em tempo real.

---

## 5. Presunção de Inocência — Registros Criminais e Cassações

> ⚠️ **Leia com atenção antes de interpretar qualquer registro.**

Campos como **"certidão criminal"** ou **"motivo de cassação"** refletem
**registros constantes nas bases de dados públicas** no momento da coleta dos dados
(04/09/2026). Eles **não** representam condenações definitivas, nem implicam culpa.

**A interpretação correta é sempre:** *"consta registro nas bases públicas"*,
**nunca** *"crime cometido"*.

A existência de um registro pode decorrer de denúncias, ações em andamento, recursos
ainda não julgados ou outros registros administrativos. O Brasil adota o princípio
constitucional da **presunção de inocência** (art. 5.º, LVII, CF/88): ninguém será
considerado culpado até o trânsito em julgado de sentença penal condenatória.

Este projeto respeita integralmente esse princípio.

---

## 6. Código Aberto

O **Resume Candidato 2026** é um projeto de código aberto (*open source*) licenciado
sob a **GNU General Public License v3.0 (GPL-3.0)**.

O código-fonte está disponível publicamente e pode ser auditado, reproduzido e
modificado conforme os termos da licença. Consulte o arquivo
[`LICENSE`](./LICENSE) para os termos completos.

---

## 7. Contato

Em caso de dúvidas sobre esta política, abra uma *issue* no repositório do projeto.

---

*Esta política pode ser atualizada. A data no topo deste documento indica a versão vigente.*
