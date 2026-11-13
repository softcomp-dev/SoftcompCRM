---
impacto: capacidade_nova
secao: adicionado
titulo: Um sistema externo cria contatos pela API REST, com token
---

Quem integra um ERP ao CRM agora consegue cadastrar o cliente pela API, com o
mesmo token usado para criar e mover cards: `POST /api/v1/contacts` com
`Authorization: Bearer dsk_…` (escopo de escrita). Antes, o ERP só conseguia
procurar contatos que já existiam, e um pedido de cliente novo chegava ao funil
sem cliente ligado.

Se o contato já existe (mesmo telefone, e-mail ou documento), a resposta é 409
com o identificador do contato existente, para o sistema usar esse em vez de
criar outro. O cabeçalho `Idempotency-Key` evita cadastro duplicado quando a
chamada é repetida. A documentação em `/docs` já descreve a rota.
