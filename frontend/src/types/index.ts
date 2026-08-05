export interface User {
  id: number
  username: string
  created_at: string
}

export interface TokenResponse {
  access_token: string
  token_type: string
  user: User
}

export interface LoginRequest {
  username: string
  password: string
}

export interface ImageConfig {
  id?: number
  user_id?: number
  baseurl: string
  api_key: string
  model_id: string
  timeout: number
  size: string
  quality: string
  n: number
  output_format: string
  output_compression: number
  background: string
  moderation: string
  updated_at?: string
}

export interface GenerateRequest {
  prompt: string
  size?: string
  quality?: string
  n?: number
  output_format?: string
  output_compression?: number
  background?: string
  moderation?: string
}

export interface GeneratedImage {
  b64_json?: string
  url?: string
  revised_prompt?: string
}

export interface GenerateResponse {
  images: GeneratedImage[]
  model: string
  prompt: string
}

export interface ApiError {
  detail: string
}
