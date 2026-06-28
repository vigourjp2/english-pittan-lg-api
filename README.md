# English Pittan Link Grammar API v62

v62: streaming action-bucket external classifier.

v60の再timeout原因は、action bucketで候補窓を広げたあと、窓内候補をまとめてLG/LT→HFへ流していたこと。
v62では候補を1件ずつstreaming判定し、外部HF分類器でOKが出た瞬間にreturnする。

HF Chat不使用。ローカル文法ハードコード不使用。
