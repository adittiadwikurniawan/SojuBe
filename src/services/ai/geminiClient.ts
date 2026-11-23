import { GoogleGenAI } from '@google/genai';

export const GEMINI_GENERATION_MODEL = 'gemini-3.8-flash' as const;
export const GEMINI_EMBEDDING_MODEL = 'gemini-embedding-001' as const;

export type EmbeddingTaskType = 'RETRIEVAL_DOCUMENT' | 'RETRIEVAL_QUERY';

export interface EmbedTextOptions {
  title?: string;
}

export interface GenerateGroundedAnswerParams {
  prompt: string;
  systemInstruction?: string;
  temperature?: number;
  maxOutputTokens?: number;
}

export interface GeminiSdkLike {
  models: {
    embedContent(params: {
      model: string;
      contents: string;
      config?: {
        taskType?: string;
        title?: string;
      };
    }): Promise<{
      embeddings?: Array<{ values?: number[] }>;
    }>;
  };
  interactions: {
    create(params: {
      model: string;
      input: string;
      store: false;
      system_instruction?: string;
      generation_config?: {
        temperature?: number;
        max_output_tokens?: number;
      };
    }): Promise<{
      output_text?: string | null;
    }>;
  };
}

export interface GeminiClient {
  embedText(
    text: string,
    taskType: EmbeddingTaskType,
    options?: EmbedTextOptions
  ): Promise<number[]>;
  generateGroundedAnswer(params: GenerateGroundedAnswerParams): Promise<string>;
}

export interface CreateGeminiClientOptions {
  apiKey?: string;
  sdk?: GeminiSdkLike;
}

export function isGeminiConfigured(apiKey = process.env.GEMINI_API_KEY): boolean {
  const trimmed = apiKey?.trim();
  return Boolean(trimmed && trimmed !== 'CHANGE_ME_GEMINI_API_KEY');
}

function resolveSdk(options?: CreateGeminiClientOptions): GeminiSdkLike {
  if (options?.sdk) {
    return options.sdk;
  }

  const apiKey = (options?.apiKey ?? process.env.GEMINI_API_KEY ?? '').trim();
  if (!isGeminiConfigured(apiKey)) {
    throw new Error('GEMINI_API_KEY belum dikonfigurasi pada environment backend.');
  }

  return new GoogleGenAI({ apiKey }) as unknown as GeminiSdkLike;
}

export function createGeminiClient(options?: CreateGeminiClientOptions): GeminiClient {
  let cachedSdk: GeminiSdkLike | null = options?.sdk ?? null;

  const getSdk = (): GeminiSdkLike => {
    if (!cachedSdk) {
      cachedSdk = resolveSdk(options);
    }
    return cachedSdk;
  };

  return {
    async embedText(
      text: string,
      taskType: EmbeddingTaskType,
      embedOptions?: EmbedTextOptions
    ): Promise<number[]> {
      const normalized = text.trim();
      if (!normalized) {
        throw new Error('Teks untuk embedding tidak boleh kosong.');
      }

      const config: { taskType: EmbeddingTaskType; title?: string } = {
        taskType,
      };
      if (taskType === 'RETRIEVAL_DOCUMENT' && embedOptions?.title?.trim()) {
        config.title = embedOptions.title.trim();
      }

      const response = await getSdk().models.embedContent({
        model: GEMINI_EMBEDDING_MODEL,
        contents: normalized,
        config,
      });

      const values = response.embeddings?.[0]?.values;
      if (!Array.isArray(values) || values.length === 0) {
        throw new Error('Gemini embedding response tidak mengembalikan vektor yang valid.');
      }

      return values;
    },

    async generateGroundedAnswer(params: GenerateGroundedAnswerParams): Promise<string> {
      const prompt = params.prompt.trim();
      if (!prompt) {
        throw new Error('Prompt untuk Gemini tidak boleh kosong.');
      }

      const generationConfig: {
        temperature?: number;
        max_output_tokens?: number;
      } = {};

      if (params.temperature !== undefined) {
        generationConfig.temperature = params.temperature;
      }
      if (params.maxOutputTokens !== undefined) {
        generationConfig.max_output_tokens = params.maxOutputTokens;
      }

      const interaction = await getSdk().interactions.create({
        model: GEMINI_GENERATION_MODEL,
        input: prompt,
        store: false,
        ...(params.systemInstruction?.trim()
          ? { system_instruction: params.systemInstruction.trim() }
          : {}),
        ...(Object.keys(generationConfig).length > 0
          ? { generation_config: generationConfig }
          : {}),
      });

      return (interaction.output_text ?? '').trim();
    },
  };
}

const defaultGeminiClient = createGeminiClient();

export function embedText(
  text: string,
  taskType: EmbeddingTaskType,
  options?: EmbedTextOptions
): Promise<number[]> {
  return defaultGeminiClient.embedText(text, taskType, options);
}

export function generateGroundedAnswer(params: GenerateGroundedAnswerParams): Promise<string> {
  return defaultGeminiClient.generateGroundedAnswer(params);
}

export default defaultGeminiClient;
