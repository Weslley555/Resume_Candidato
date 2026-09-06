# Política de Privacidade — Radar Eleitoral 2026

> **Última atualização:** 04 de setembro de 2026

---

## 1. Visão Geral

O **Radar Eleitoral 2026** é uma ferramenta de consulta pública de dados eleitorais.
Esta política descreve de forma transparente quais dados são (e **não são**) coletados
ou processados ao utilizar o site.

---

## 2. O que este site NÃO faz

- **Não cria contas de usuário** — nenhum cadastro, login ou perfil é necessário ou armazenado.
- **Não utiliza cookies de rastreamento** — nenhum cookie analítico, publicitário ou de sessão
  é gravado no seu navegador.
- **Não armazena histórico de buscas** — as pesquisas realizadas são processadas localmente
  no seu navegador e não são enviadas, registradas ou associadas a qualquer identidade.

---

## 3. Endereço IP e Rate Limiting

As rotas `/api` do projeto utilizam **rate limiting** (limitação de requisições) para proteger
o serviço contra abusos automatizados.

- O endereço IP de cada requisição é processado **temporariamente** e de forma exclusiva
  para fins de controle de taxa de acesso.
- Esse dado é descartado automaticamente em **até 1 minuto**, sem nenhum tipo de persistência.
- O IP **não é vinculado** a nenhuma busca realizada, candidato consultado ou qualquer outra
  informação de uso.

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

O **Radar Eleitoral 2026** é um projeto de código aberto (*open source*) licenciado
sob a **GNU General Public License v3.0 (GPL-3.0)**.

O código-fonte está disponível publicamente e pode ser auditado, reproduzido e
modificado conforme os termos da licença. Consulte o arquivo
[`LICENSE`](./LICENSE) para os termos completos.

---

## 7. Contato

Em caso de dúvidas sobre esta política, abra uma *issue* no repositório do projeto.

---

*Esta política pode ser atualizada. A data no topo deste documento indica a versão vigente.*
