---
impacto: capacidade_nova
secao: adicionado
titulo: O negócio guarda o número da cotação ou do pedido
---

Quem vende por cotação e fecha por pedido no sistema de gestão não tinha onde anotar no
negócio qual é o documento lá fora, e o número acabava perdido na descrição. Agora a
edição do negócio, tanto no **Funil** quanto no dossiê da conversa, tem o campo
**Número da cotação ou do pedido**, com a escolha **Cotação** ou **Pedido** ao lado. O
negócio é um ou outro, nunca os dois: quando a cotação vira pedido, troque a escolha e o
número e salve.

Apagar o número limpa o documento inteiro. A mudança entra na linha do tempo do negócio
e na auditoria, com o antes e o depois. Pela API, o `PATCH /api/v1/leads/{id}` aceita
`sales_document_kind` (`quote` ou `order`) e `sales_document_number`.

A atualização aplica a migration sozinha; os negócios existentes ficam sem documento até
alguém preencher.
