---
impacto: capacidade_nova
secao: adicionado
titulo: A ligação pela telefonia SIP chega a uma pessoa do time
---

Os modos **Time humano** e **IA, depois time humano** do número de voz passaram
a funcionar. Antes eles podiam ser escolhidos na tela, mas toda ligação ia para
a IA. Agora o número tem o campo **Telefone do time**. No modo Time humano, a
ligação toca direto nesse telefone, discada pelo mesmo tronco SIP. No modo IA,
depois time humano, o agente de voz atende e transfere a ligação para o time
quando a pessoa pede ou o assunto exige. Se ninguém atender, a ligação vira o
aviso **Ligar de volta** na Central. A ligação recebida que ninguém atende, ou
que chega sem agente de voz ativo, também passa a virar esse aviso. A ligação
atendida aparece na linha do tempo do negócio. Cada ligação encaminhada ao time
gasta minutos de saída do tronco. O telefone direto no navegador ainda não
existe. A atualização reinicia o Asterisk de quem tem a telefonia ligada, para
ele receber as regras novas.
