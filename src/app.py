import os
from google import genai
from fastapi import FastAPI, StreamingResponse
from fastapi.staticfiles import StaticFiles

ENVIRONMENT = os.getenv('ENVIRONMENT')
GEMINI_API_KEY = os.getenv('GEMINI_API_KEY')
GEMINI_MODEL = 'gemini-2.5-flash'

if not GEMINI_API_KEY:
  raise Exception("GEMINI_API_KEY is a required environmental variable")

def get_client():
  return genai.Client(GEMINI_API_KEY)

app = FastAPI()

if ENVIRONMENT in ('development', 'dev', None):
  app.mount("/static", StaticFiles(directory="static", html=True), name="static")

# @app.get("/")
# async def home():
#     return 

@app.post("/chat")
async def chat(prompt: str, client: genai.Client = Depends(get_client)):
    
    async def gen():
        async for chunk in client.aio.models.generate_content_stream(
            model=MODEL,
            contents=prompt
        ):
            if chunk.text:
                yield chunk.text

    return StreamingResponse(
        gen(),
        media_type='text/plain'
    )
