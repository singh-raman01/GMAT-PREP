# Generated Data Insights keys are computed by code

A model can slip on arithmetic or misread its own table, and a wrong key teaches the wrong answer. For a Generated Question the LLM writes the Dataset and the statements, code computes the answer key from the Dataset, and the chart is drawn from the same Dataset, so text, chart and key cannot disagree. Statements code cannot evaluate, such as MSR inferences, publish only after independent solver runs agree with the key and the Curator approves. Expected result: no generated key depends on model arithmetic alone.
