---
impacto: capacidade_nova
secao: adicionado
titulo: Pela API, o ERP configura o próprio webhook de aviso e lê as etiquetas
---

Quem instala a integração para vários clientes agora configura o aviso de volta
para o ERP sem entrar na tela de cada CRM: com um token de **administrador**, a
API cria, lista, edita, ativa e apaga as regras de automação
(`/api/v1/automation-rules`), inclusive a de "Chamar webhook". A regra criada
pela API nasce pausada, a URL passa pelas mesmas proteções da tela e o segredo
de assinatura é guardado cifrado e nunca devolvido.

O ERP também passa a ler as etiquetas em uso (`GET /api/v1/contact-tags`), para
filtrar contatos com a grafia exata.
