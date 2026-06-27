# English Pittan Link Grammar API

Link Grammar + Hugging Face Chat acceptability judge.

## Environment variables

- `HF_TOKEN`: Hugging Face token with Inference Providers permission
- `HF_CHAT_MODEL`: optional, default `deepseek-ai/DeepSeek-R1:fastest`
- `HF_CHAT_URL`: optional, default `https://router.huggingface.co/v1/chat/completions`

## Endpoints

- `/health`
- `/check?text=I%20like%20you`
- `/check-and-translate?text=I%20like%20you`
- `/check-and-translate-batch` POST `{ "candidates": [{"text":"I like listening","words":["I","like","listening"]}] }`
- `/acceptability?text=I%20like%20you`
- `/translate?text=I%20like%20you`
