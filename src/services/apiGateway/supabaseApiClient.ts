import { BaseApiClient, StandardizedApiResponse, withRetry } from './standardizedApiClient';
import { supabaseConfig, SupabaseConfigUtils } from '../../config/apis/supabaseConfig';
import { z } from 'zod';

// Define types for Supabase Edge Functions
export type SupabaseParams = {
  functionName: string;
  data?: any;
};

export type SupabaseResponse = {
  success: boolean;
  [key: string]: any;
};

/**
 * Standardized Supabase Edge Functions API client that extends the base client
 * while preserving all Supabase-specific functionality and schemas
 */
export class SupabaseApiClient extends BaseApiClient<SupabaseParams, SupabaseResponse> {
  private supabaseUrl: string;
  private supabaseKey: string;

  constructor(apiKey: string, functionName?: string) {
    super('supabase', functionName);
    
    // Extract Supabase URL and key from the API key
    // Expected format: "url|key" or just the key if URL is in env
    const parts = apiKey.split('|');
    if (parts.length === 2) {
      this.supabaseUrl = parts[0];
      this.supabaseKey = parts[1];
    } else {
      // Fallback to environment variable for URL
      this.supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || supabaseConfig.projectUrl;
      this.supabaseKey = apiKey;
    }

    if (!this.supabaseUrl || !this.supabaseKey) {
      throw new Error('Supabase URL and key are required');
    }
  }

  public validateParams(params: unknown): SupabaseParams {
    // First, basic type checking
    if (!params || typeof params !== 'object') {
      throw new Error('Parameters must be an object');
    }

    const typedParams = params as any;
    
    if (!typedParams.functionName || typeof typedParams.functionName !== 'string') {
      throw new Error('Function name is required and must be a string');
    }

    const functionConfig = SupabaseConfigUtils.getFunctionConfig(typedParams.functionName);
    if (!functionConfig) {
      throw new Error(`Function ${typedParams.functionName} not found in Supabase configuration`);
    }

    // Validate input data against function schema
    if (typedParams.data) {
      try {
        functionConfig.inputSchema.parse(typedParams.data);
      } catch (error) {
        if (error instanceof z.ZodError) {
          throw new Error(`Validation error: ${error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join(', ')}`);
        }
        throw new Error('Unknown validation error');
      }
    }

    return {
      functionName: typedParams.functionName,
      data: typedParams.data
    };
  }

  public async execute(params: SupabaseParams): Promise<StandardizedApiResponse<SupabaseResponse>> {
    return this.makeRequest(params);
  }

  public async healthCheck(): Promise<boolean> {
    try {
      const response = await fetch(`${this.supabaseUrl}/functions/v1/health`, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${this.supabaseKey}`,
        },
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  protected async makeRequest(params: SupabaseParams): Promise<StandardizedApiResponse<SupabaseResponse>> {
    this.validateParams(params);

    const functionConfig = SupabaseConfigUtils.getFunctionConfig(params.functionName);
    const retryAttempts = supabaseConfig.retryAttempts || 3;
    const timeout = functionConfig?.timeout || supabaseConfig.timeout;

    return withRetry(async () => {
      const url = SupabaseConfigUtils.buildFunctionUrl(params.functionName);
      const requestOptions = this.buildRequestOptions(params, timeout);

      const response = await fetch(url, requestOptions);

      if (!response.ok) {
        await this.handleErrorResponse(response);
      }

      const data = await response.json();

      return {
        success: true,
        data: data as SupabaseResponse,
        metadata: {
          apiType: 'supabase',
          modelId: params.functionName,
          timestamp: new Date().toISOString(),
          requestId: `supabase-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
          statusCode: response.status
        }
      };
    }, { maxAttempts: retryAttempts });
  }

  private buildRequestOptions(params: SupabaseParams, timeout: number): RequestInit {
    const headers = SupabaseConfigUtils.getAuthHeaders(false); // Use anon key by default

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    return {
      method: 'POST',
      headers,
      body: JSON.stringify(params.data || {}),
      signal: controller.signal,
    };
  }

  private async handleErrorResponse(response: Response): Promise<never> {
    const errorText = await response.text();
    let errorMessage = `Supabase Edge Function error: ${response.status} ${response.statusText}`;
    
    try {
      const errorData = JSON.parse(errorText);
      if (errorData.error) {
        errorMessage += ` - ${errorData.error}`;
      }
      if (errorData.details) {
        errorMessage += ` (${errorData.details})`;
      }
    } catch {
      // If error response is not JSON, use the raw text
      if (errorText) {
        errorMessage += ` - ${errorText}`;
      }
    }

    // Enhanced error handling for common Supabase Edge Function errors
    if (response.status === 401) {
      errorMessage += ' - Check your Supabase API key and permissions';
    } else if (response.status === 403) {
      errorMessage += ' - Insufficient permissions for this Edge Function';
    } else if (response.status === 404) {
      errorMessage += ' - Edge Function not found or not deployed';
    } else if (response.status === 422) {
      errorMessage += ' - Invalid request data or function validation failed';
    } else if (response.status === 429) {
      errorMessage += ' - Rate limit exceeded, please try again later';
    } else if (response.status >= 500) {
      errorMessage += ' - Supabase server error, please try again later';
    }

    throw new Error(errorMessage);
  }
}