---
impacto: capacidade_nova
secao: adicionado
titulo: Pela API, o ERP lê e atualiza a ficha do contato e descobre os vendedores
---

Com o token de integração, um sistema externo agora consegue ler a ficha de um
contato (`GET /api/v1/contacts/{id}`) e atualizá-la (`PATCH`), com as mesmas
regras da tela: documento validado pela régua do país e recusa com o
identificador do contato existente quando o telefone, o e-mail ou o documento
já são de outra pessoa. O CPF nunca sai em claro, e apagar contato continua só
pela tela.

Também passa a ler a lista de quem pode ser responsável por um negócio
(`GET /api/v1/team/assignable`) com o e-mail de cada pessoa, para casar o
vendedor do ERP com o do CRM antes de atribuir o negócio.
