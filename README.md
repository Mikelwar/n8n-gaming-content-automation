\# AI Gaming Content Automation with n8n



An end-to-end AI-assisted gaming content automation system built with \*\*n8n\*\*.



The project combines game research, asset discovery, source evaluation, voiceover generation, media processing, and quality-control workflows into a modular content-production pipeline.



\## Overview



Key capabilities include:



\- AI-assisted gaming review generation

\- Automated game asset discovery

\- Source ranking and filtering

\- Usage-policy and rights checks

\- Voiceover generation and audio assembly

\- Video and audio processing with FFmpeg

\- Automated video quality-control checks

\- Structured handoff between workflow stages



\## Main Workflow



The main AI agent coordinates the content-production pipeline and routes tasks to specialized workflows.



!\[Main AI Agent Workflow](docs/screenshots/01-main-ai-agent-workflow.jpg)



\*\*Main AI Agent Workflow\*\*  

Main AI agent workflow orchestrating the end-to-end gaming review pipeline.



\## Game Asset Discovery



The asset-discovery workflow searches for relevant game footage and images, evaluates sources, ranks candidates, and prepares usable assets for downstream processing.



!\[Game Asset Discovery Pipeline](docs/screenshots/02-game-asset-discovery-pipeline.jpg)



\*\*Game Asset Discovery Pipeline\*\*  

Asset discovery workflow for finding and ranking usable gameplay, trailer, and image sources.



The workflow includes:



\- Game-title relevance checking

\- Source classification and ranking

\- Duplicate and previously-used source filtering

\- Rights and usage-policy checks

\- Multiple-source collection

\- Clip preparation

\- Temporal overlap detection and trimming

\- Editorial timeline preparation



\## Successful Workflow Execution



!\[Successful Asset Workflow Execution](docs/screenshots/03-successful-asset-workflow-execution.jpg)



\*\*Successful Asset Workflow Execution\*\*  

Successful asset discovery execution showing collected results ready for downstream production.



\## Voiceover Generation



!\[Voiceover Generation Workflow](docs/screenshots/04-voiceover-generation-workflow.jpg)



\*\*Voiceover Generation Workflow\*\*  

Voiceover generation with chunk management, TTS routing, audio assembly, and duration checks.



\## Final Output \& Quality Control



!\[Final Video Output and QC](docs/screenshots/05-final-video-output-and-qc.jpg)



\*\*Final Video Output \& Quality Control\*\*  

Final rendered review output and QC stage, including the finished video preview.



\## Tech Stack



\- \*\*n8n\*\* — workflow orchestration

\- \*\*OpenAI\*\* — AI-assisted research and structured processing

\- \*\*Serper\*\* — search and asset discovery

\- \*\*ElevenLabs\*\* — text-to-speech generation

\- \*\*Google Gemini\*\* — media quality-control workflows

\- \*\*FFmpeg / FFprobe\*\* — video and audio processing

\- \*\*Node.js\*\* — custom media-processing logic



\## Repository Structure



```text

n8n-gaming-content-automation/

├── workflows/

│   ├── gaming-review-main.json

│   ├── find-game-assets.json

│   ├── generate-voiceover.json

│   └── video-qc.json

├── scripts/

│   └── render-review.cjs

├── examples/

│   ├── review-config.json

│   └── voice-config.json

├── prompts/

├── docs/

│   └── screenshots/

└── README.md

