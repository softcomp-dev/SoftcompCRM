---
impacto: nada_mudou
secao: corrigido
titulo: Telefonia SIP usa o agente e o tronco escolhidos na tela
---

A ligação recebida passa a ser atendida pelo agente de voz escolhido para o
número, e não pelo primeiro agente de voz ativo. A ligação feita pelo CRM passa
a sair pelo tronco salvo em Configurações › Trunk SIP. Antes ela falhava no
Asterisk para quem tinha cadastrado o tronco por essa tela. Pedir uma ligação
com o atendente falando (`mode: "human"` na API) agora é recusado com uma
explicação. Antes a IA atendia no lugar do atendente sem avisar.
