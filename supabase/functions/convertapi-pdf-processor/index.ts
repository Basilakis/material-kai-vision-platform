import "https://deno.land/x/xhr@0.1.0/mod.ts";
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const supabase = createClient(
  Deno.env.get('SUPABASE_URL') ?? '',
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
);

const openaiApiKey = Deno.env.get('OPENAI_API_KEY');
const convertApiKey = Deno.env.get('CONVERTAPI_KEY');

console.log('🔑 Environment check:');
console.log('- OpenAI API key:', openaiApiKey ? 'Set' : 'Missing');
console.log('- ConvertAPI key:', convertApiKey ? 'Set' : 'Missing');

interface ConvertAPIProcessingRequest {
  fileUrl: string;
  originalFilename: string;
  fileSize: number;
  userId: string;
  options?: {
    extractMaterials?: boolean;
    language?: string;
    maxPages?: number; // Maximum pages to process (0 = all pages, default: 50)
  };
}

interface ProcessedImage {
  originalUrl: string;
  supabaseUrl: string;
  filename: string;
  size: number;
}

// Simple text extraction from HTML (memory optimized)
function extractTextFromHTML(html: string): string {
  // Remove scripts, styles, and other non-content elements
  let text = html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');
  text = text.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');
  text = text.replace(/<[^>]+>/g, ' ');
  
  // Decode HTML entities
  text = text.replace(/&nbsp;/g, ' ');
  text = text.replace(/&amp;/g, '&');
  text = text.replace(/&lt;/g, '<');
  text = text.replace(/&gt;/g, '>');
  text = text.replace(/&quot;/g, '"');
  text = text.replace(/&#39;/g, "'");
  
  // Clean up whitespace and limit length
  text = text.replace(/\s+/g, ' ').trim();
  return text.substring(0, 8000); // Limit to 8000 chars to avoid memory issues
}

// Extract image URLs from HTML (no limits)
function extractImageUrls(html: string): string[] {
  const imageUrls: string[] = [];
  const imgRegex = /<img[^>]+src=["\']([^"\']+)["\'][^>]*>/gi;
  let match;
  
  while ((match = imgRegex.exec(html)) !== null) {
    const url = match[1];
    if (url && url.startsWith('http')) {
      imageUrls.push(url);
    }
  }
  
  return imageUrls;
}

// Extract base64 images from HTML
function extractBase64Images(html: string): Array<{src: string, data: string, type: string}> {
  const base64Images: Array<{src: string, data: string, type: string}> = [];
  
  // More comprehensive regex to find all base64 image data URLs
  const patterns = [
    // Standard img src attributes
    /<img[^>]+src=["\']data:image\/([^;]+);base64,([^"\']+)["\'][^>]*>/gi,
    // Standalone data URLs that might be in other contexts
    /data:image\/([^;]+);base64,([^\s"'><]+)/gi
  ];
  
  const foundDataUrls = new Set<string>();
  
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(html)) !== null) {
      const type = match[1]; // png, jpg, etc.
      const data = match[2]; // base64 data
      const dataUrl = `data:image/${type};base64,${data}`;
      
      // Avoid duplicates
      if (!foundDataUrls.has(dataUrl)) {
        foundDataUrls.add(dataUrl);
        base64Images.push({
          src: dataUrl, // Store just the data URL for consistent replacement
          data: data,
          type: type
        });
      }
    }
  }
  
  console.log(`Found ${base64Images.length} base64 images to convert`);
  return base64Images;
}

// Convert base64 image to file and upload to Supabase
async function processBase64Image(
  base64Data: string, 
  imageType: string, 
  userId: string, 
  index: number
): Promise<{originalSrc: string, supabaseUrl: string, filename: string} | null> {
  try {
    // Decode base64 to binary
    const binaryString = atob(base64Data);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    
    const filename = `base64-image-${index}-${Date.now()}.${imageType}`;
    const storagePath = `${userId}/pdf-images/${filename}`;
    
    const { error: uploadError } = await supabase.storage
      .from('pdf-documents')
      .upload(storagePath, bytes, {
        contentType: `image/${imageType}`,
        upsert: false
      });
    
    if (uploadError) {
      console.error(`Failed to upload base64 image ${index}:`, uploadError);
      return null;
    }
    
    const { data: { publicUrl } } = supabase.storage
      .from('pdf-documents')
      .getPublicUrl(storagePath);
    
    console.log(`✅ Converted base64 image ${index} to: ${publicUrl}`);
    return {
      originalSrc: `data:image/${imageType};base64,${base64Data}`,
      supabaseUrl: publicUrl,
      filename: filename
    };
  } catch (error) {
    console.error(`Failed to process base64 image ${index}:`, error);
    return null;
  }
}

// Generate embeddings using OpenAI (memory optimized)
async function generateEmbedding(text: string): Promise<number[]> {
  if (!openaiApiKey) {
    console.warn('⚠️ OpenAI API key not found, skipping embedding generation');
    return [];
  }

  try {
    // Limit text length for embedding
    const limitedText = text.substring(0, 4000);
    
    const response = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${openaiApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        input: limitedText,
        model: 'text-embedding-3-small'
      })
    });

    if (!response.ok) {
      throw new Error(`OpenAI API error: ${response.status}`);
    }

    const data = await response.json();
    return data.data[0].embedding;
  } catch (error) {
    console.error('❌ Error generating embedding:', error);
    return [];
  }
}

// Download and store a single image (with error handling)
async function downloadAndStoreImage(imageUrl: string, userId: string, index: number): Promise<ProcessedImage | null> {
  try {
    console.log(`📥 Downloading image ${index + 1}: ${imageUrl}`);
    
    const response = await fetch(imageUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; PDF-Processor/1.0)'
      }
    });
    
    if (!response.ok) {
      console.warn(`⚠️ Failed to download image ${index + 1}: ${response.status}`);
      return null;
    }

    // Check content type and size
    const contentType = response.headers.get('content-type');
    if (!contentType?.startsWith('image/')) {
      console.warn(`⚠️ Invalid content type for image ${index + 1}: ${contentType}`);
      return null;
    }

    const blob = await response.blob();
    
    // Limit image size to 5MB
    if (blob.size > 5 * 1024 * 1024) {
      console.warn(`⚠️ Image ${index + 1} too large: ${blob.size} bytes`);
      return null;
    }

    // Generate filename
    const extension = contentType.split('/')[1] || 'jpg';
    const filename = `pdf-image-${index + 1}-${Date.now()}.${extension}`;
    const storagePath = `${userId}/pdf-images/${filename}`;

    // Upload to Supabase storage
    const { data, error } = await supabase.storage
      .from('material-images')
      .upload(storagePath, blob, {
        contentType: contentType,
        upsert: false
      });

    if (error) {
      console.error(`❌ Failed to upload image ${index + 1}:`, error);
      return null;
    }

    // Get public URL
    const { data: { publicUrl } } = supabase.storage
      .from('material-images')
      .getPublicUrl(storagePath);

    console.log(`✅ Successfully stored image ${index + 1}`);
    
    return {
      originalUrl: imageUrl,
      supabaseUrl: publicUrl,
      filename: filename,
      size: blob.size
    };

  } catch (error) {
    console.error(`❌ Error processing image ${index + 1}:`, error);
    return null;
  }
}

// Replace image URLs in HTML with Supabase URLs
function replaceImageUrls(html: string, processedImages: ProcessedImage[]): string {
  let updatedHtml = html;
  
  for (const image of processedImages) {
    updatedHtml = updatedHtml.replace(
      new RegExp(image.originalUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'),
      image.supabaseUrl
    );
  }
  
  return updatedHtml;
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    console.log('🚀 ConvertAPI PDF processor started');
    
    // Check for required environment variables
    if (!convertApiKey) {
      console.error('❌ CONVERTAPI_KEY environment variable is missing');
      return new Response(
        JSON.stringify({ 
          error: 'ConvertAPI key not configured',
          details: 'The CONVERTAPI_KEY environment variable must be set in edge function secrets'
        }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const requestData: ConvertAPIProcessingRequest = await req.json();
    const { fileUrl, originalFilename, fileSize, userId, options = {} } = requestData;

    if (!fileUrl || !originalFilename || !userId) {
      return new Response(
        JSON.stringify({ error: 'Missing required fields: fileUrl, originalFilename, userId' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    console.log('🚀 Starting ConvertAPI PDF processing for:', originalFilename);

    // Create initial processing record
    const { data: processingRecord, error: createError } = await supabase
      .from('pdf_processing_results')
      .insert({
        user_id: userId,
        original_filename: originalFilename,
        file_size: fileSize,
        file_url: fileUrl,
        processing_status: 'processing',
        processing_started_at: new Date().toISOString(),
        processing_time_ms: 0,
        total_pages: 1
      })
      .select()
      .single();

    if (createError) {
      throw new Error(`Failed to create processing record: ${createError.message}`);
    }

    const processingId = processingRecord.id;
    const startTime = Date.now();

    try {
      // STEP 1: Call ConvertAPI for HTML conversion
      console.log('📄 Step 1: Converting PDF to HTML with ConvertAPI...');
      
      // Configure page range - allow processing of entire PDF or limit based on options
      const maxPages = options?.maxPages ?? 50; // Default to 50 pages, configurable
      const shouldLimitPages = maxPages > 0;
      
      console.log(`📄 Processing PDF pages: ${shouldLimitPages ? `1-${maxPages}` : 'all pages'}`);
      
      const convertApiParams = [
        {
          Name: 'File',
          FileValue: {
            Url: fileUrl
          }
        },
        {
          Name: 'EmbedCss',
          Value: true
        },
        {
          Name: 'EmbedImages',
          Value: false // We'll handle images separately
        }
      ];
      
      // Only add PageRange if we want to limit pages
      if (shouldLimitPages) {
        convertApiParams.push({
          Name: 'PageRange',
          Value: `1-${maxPages}` as any
        });
      }
      
      const response = await fetch('https://v2.convertapi.com/convert/pdf/to/html', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${convertApiKey}`,
        },
        body: JSON.stringify({
          Parameters: convertApiParams
        })
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`ConvertAPI request failed: ${response.status} - ${errorText}`);
      }

      const result = await response.json();
      console.log('✅ ConvertAPI conversion completed');
      console.log('📋 ConvertAPI result structure:', JSON.stringify(result, null, 2));

      if (!result.Files || result.Files.length === 0) {
        throw new Error('No HTML file returned from ConvertAPI');
      }

      // Get the HTML file URL
      const htmlFile = result.Files.find((file: any) => file.FileName.endsWith('.html'));
      if (!htmlFile) {
        console.error('❌ Available files:', result.Files.map((f: any) => ({ FileName: f.FileName, keys: Object.keys(f) })));
        throw new Error('No HTML file found in ConvertAPI response');
      }

      console.log('📄 HTML file object:', JSON.stringify(htmlFile, null, 2));
      
      // STEP 2: Extract HTML content
      console.log('📥 Step 2: Extracting HTML content...');
      let htmlContent: string;
      
      // Always prefer downloading from URL to get clean HTML content
      if (htmlFile.Url || htmlFile.url || htmlFile.FileUrl || htmlFile.downloadUrl) {
        const htmlFileUrl = htmlFile.Url || htmlFile.url || htmlFile.FileUrl || htmlFile.downloadUrl;
        console.log('📥 Downloading HTML content from URL:', htmlFileUrl);
        const htmlResponse = await fetch(htmlFileUrl);
        if (!htmlResponse.ok) {
          throw new Error(`Failed to download HTML: ${htmlResponse.status}`);
        }
        htmlContent = await htmlResponse.text();
        console.log('✅ Downloaded clean HTML content from URL');
      } else if (htmlFile.FileData) {
        // Fallback: try to decode FileData if it's base64 encoded
        console.log('⚠️ Using FileData as fallback, checking for base64 encoding...');
        let rawData = htmlFile.FileData;
        
        // Check if it's base64 encoded (common with ConvertAPI)
        try {
          // If it looks like base64, decode it
          if (typeof rawData === 'string' && /^[A-Za-z0-9+/]*={0,2}$/.test(rawData.replace(/\s/g, ''))) {
            console.log('🔍 Detected base64 encoding, decoding...');
            htmlContent = atob(rawData);
            console.log('✅ Successfully decoded base64 HTML content');
          } else {
            // Use as-is if not base64
            htmlContent = rawData;
            console.log('✅ Using FileData as plain text');
          }
        } catch (decodeError) {
          console.warn('⚠️ Failed to decode base64, using raw data:', decodeError);
          htmlContent = rawData;
        }
      } else {
        console.error('❌ HTML file object keys:', Object.keys(htmlFile));
        throw new Error(`No HTML content found. Available properties: ${Object.keys(htmlFile).join(', ')}`);
      }

      console.log(`✅ Extracted HTML content (${htmlContent.length} characters)`);

      // STEP 3: Extract and process images (limited)
      console.log('🖼️ Step 3: Processing images...');
      const imageUrls = extractImageUrls(htmlContent);
      const base64Images = extractBase64Images(htmlContent);
      console.log(`Found ${imageUrls.length} HTTP images and ${base64Images.length} base64 images to process`);

      const processedImages: ProcessedImage[] = [];
      const processedBase64Images: Array<{originalSrc: string, supabaseUrl: string, filename: string}> = [];
      
      // Process ALL HTTP images (removed the 5-image limit)
      for (let i = 0; i < imageUrls.length; i++) {
        const imageUrl = imageUrls[i];
        const processedImage = await downloadAndStoreImage(imageUrl, userId, i);
        if (processedImage) {
          processedImages.push(processedImage);
        }
        
        // Small delay between images to avoid overwhelming the system
        await new Promise(resolve => setTimeout(resolve, 100));
      }

      // Process ALL base64 images (removed the limit of 5)
      for (let i = 0; i < base64Images.length; i++) {
        const base64Image = base64Images[i];
        const processedBase64 = await processBase64Image(base64Image.data, base64Image.type, userId, i);
        if (processedBase64) {
          processedBase64Images.push(processedBase64);
        }
        
        // Small delay between images to avoid overwhelming the system
        await new Promise(resolve => setTimeout(resolve, 100));
      }

      console.log(`✅ Processed ${processedImages.length} HTTP images and ${processedBase64Images.length} base64 images successfully`);

      // STEP 4: Replace image URLs and store final HTML
      console.log('🔄 Step 4: Finalizing HTML content...');
      let finalHtmlContent = replaceImageUrls(htmlContent, processedImages);
      
      // More comprehensive base64 image replacement
      for (const base64Image of processedBase64Images) {
        // Use a global replace to catch all instances of the base64 image
        const escapedSrc = base64Image.originalSrc.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        finalHtmlContent = finalHtmlContent.replace(
          new RegExp(escapedSrc, 'g'),
          base64Image.supabaseUrl
        );
      }
      
      // Additional cleanup: find any remaining base64 images and log them
      const remainingBase64 = finalHtmlContent.match(/data:image\/[^;]+;base64,[^"'\s>]+/g);
      if (remainingBase64 && remainingBase64.length > 0) {
        console.warn(`⚠️ Found ${remainingBase64.length} remaining base64 images that weren't replaced`);
        console.warn('Remaining base64 patterns:', remainingBase64.slice(0, 3)); // Log first 3 for debugging
      }

      // Store final HTML in Supabase storage
      const htmlStoragePath = `${userId}/pdf-html/${originalFilename.replace('.pdf', '')}-${Date.now()}.html`;
      const { error: htmlUploadError } = await supabase.storage
        .from('pdf-documents')
        .upload(htmlStoragePath, finalHtmlContent, {
          contentType: 'text/html',
          upsert: false
        });

      if (htmlUploadError) {
        console.warn(`⚠️ Failed to upload HTML to storage: ${htmlUploadError.message}`);
      }

      const { data: { publicUrl: htmlPublicUrl } } = supabase.storage
        .from('pdf-documents')
        .getPublicUrl(htmlStoragePath);

      // STEP 5: Extract text and generate embeddings
      console.log('📝 Step 5: Processing text content...');
      const extractedText = extractTextFromHTML(finalHtmlContent);
      const embedding = await generateEmbedding(extractedText);

      // STEP 6: Store in knowledge base
      console.log('💾 Step 6: Storing in knowledge base...');
      console.log(`📊 Content sizes - HTML: ${finalHtmlContent.length} chars, Text: ${extractedText.length} chars`);
      console.log(`📋 HTML content preview (first 200 chars):`, finalHtmlContent.substring(0, 200));
      
      // If content is too large (>1MB), truncate but keep essential structure
      let contentToStore = finalHtmlContent;
      const maxContentSize = 1024 * 1024; // 1MB limit
      if (finalHtmlContent.length > maxContentSize) {
        console.log(`⚠️ Content too large (${finalHtmlContent.length} chars), truncating to ${maxContentSize} chars`);
        contentToStore = finalHtmlContent.substring(0, maxContentSize) + '\n<!-- Content truncated due to size -->'; 
      }
      
      const knowledgeEntry = {
        title: `${originalFilename.replace('.pdf', '')} - HTML Document`,
        content: contentToStore, // Store HTML with local images for rich display
        content_type: 'enhanced_pdf_html', // Match the type expected by HTMLDocumentViewer
        source_url: htmlPublicUrl, // Point to the HTML file, not original PDF
        semantic_tags: ['pdf', 'html', 'convertapi', 'uploaded-content'],
        language: options.language || 'en',
        technical_complexity: 5,
        reading_level: 8,
        openai_embedding: embedding.length > 0 ? embedding : null,
        confidence_scores: {
          conversion: 0.9,
          text_extraction: 0.85,
          image_processing: processedImages.length > 0 ? 0.8 : 0.0,
          overall: 0.87
        },
        search_keywords: extractedText.split(' ').filter(word => word.length > 3).slice(0, 15),
        metadata: {
          source_type: 'convertapi_pdf_upload',
          processing_method: 'convertapi_html_conversion_optimized',
          file_info: {
            original_filename: originalFilename,
            file_size: fileSize,
            processing_date: new Date().toISOString()
          },
          storage_info: {
            html_storage_url: htmlPublicUrl,
            images_processed: processedImages.length,
            images_found: imageUrls.length,
            base64_images_processed: processedBase64Images.length,
            base64_images_found: base64Images.length
          },
          processed_images: processedImages.map(img => ({
            original_url: img.originalUrl,
            supabase_url: img.supabaseUrl,
            filename: img.filename,
            size: img.size
          })),
          text_preview: extractedText.substring(0, 500) // Keep text for search/preview
        },
        created_by: userId,
        last_modified_by: userId,
        status: 'published'
      };

      const { data: knowledgeData, error: knowledgeError } = await supabase
        .from('enhanced_knowledge_base')
        .insert(knowledgeEntry)
        .select()
        .single();

      if (knowledgeError) {
        throw new Error(`Failed to add document to knowledge base: ${knowledgeError.message}`);
      }

      // STEP 7: Update processing results
      const processingTime = Date.now() - startTime;
      await supabase
        .from('pdf_processing_results')
        .update({
          processing_status: 'completed',
          processing_completed_at: new Date().toISOString(),
          processing_time_ms: processingTime,
          document_title: knowledgeEntry.title,
          confidence_score_avg: 0.87,
          document_keywords: knowledgeEntry.search_keywords?.join(', '),
          document_classification: {
            content_type: 'pdf_html_document',
            processing_method: 'convertapi_html_conversion_optimized'
          }
        })
        .eq('id', processingId);

      console.log(`🎉 ConvertAPI PDF processing completed in ${processingTime}ms`);

      return new Response(
        JSON.stringify({
          success: true,
          processingId: processingId,
          knowledgeEntryId: knowledgeData.id,
          processingTimeMs: processingTime,
          confidence: 0.87,
          extractedContent: {
            textLength: extractedText.length,
            htmlLength: finalHtmlContent.length,
            title: knowledgeEntry.title,
            htmlUrl: htmlPublicUrl
          },
          conversionInfo: {
            imagesFound: imageUrls.length,
            imagesProcessed: processedImages.length,
            base64ImagesFound: base64Images.length,
            base64ImagesProcessed: processedBase64Images.length,
            pagesProcessed: 10
          },
          message: 'PDF successfully converted to HTML and processed with ConvertAPI (memory-optimized)'
        }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );

    } catch (processingError) {
      console.error('❌ Error during ConvertAPI PDF processing:', processingError);
      console.error('Processing error details:', {
        name: processingError instanceof Error ? processingError.name : 'Unknown',
        message: processingError instanceof Error ? processingError.message : String(processingError),
        step: 'PDF processing pipeline',
        timestamp: new Date().toISOString()
      });
      
      // Categorize processing errors with specific guidance
      let errorCategory = 'PROCESSING_ERROR';
      let userMessage = 'Failed during PDF processing pipeline.';
      let troubleshooting: string[] = [];
      let technicalDetails = processingError instanceof Error ? processingError.message : String(processingError);

      if (processingError instanceof Error) {
        const errorMsg = processingError.message.toLowerCase();
        
        if (errorMsg.includes('convertapi request failed')) {
          errorCategory = 'CONVERTAPI_REQUEST_FAILED';
          userMessage = 'ConvertAPI service rejected the PDF conversion request.';
          troubleshooting = [
            'Verify the PDF file is not corrupted or password-protected',
            'Check if the file size is under 25MB limit',
            'Ensure the PDF contains readable text (not just scanned images)',
            'Try a different PDF file to test the service',
            'Check ConvertAPI account credits and service status'
          ];
        } else if (errorMsg.includes('no html file')) {
          errorCategory = 'CONVERSION_FAILED';
          userMessage = 'PDF to HTML conversion did not produce expected output.';
          troubleshooting = [
            'The PDF may be corrupted or in an unsupported format',
            'Try converting the PDF to a newer format first',
            'Ensure the PDF has actual content (not just images)',
            'Contact support with the problematic PDF file'
          ];
        } else if (errorMsg.includes('failed to download html')) {
          errorCategory = 'DOWNLOAD_FAILED';
          userMessage = 'Could not download the converted HTML from ConvertAPI.';
          troubleshooting = [
            'Check your internet connection stability',
            'Retry the conversion process',
            'ConvertAPI servers may be temporarily unavailable',
            'Contact support if the issue persists'
          ];
        } else if (errorMsg.includes('failed to upload') || errorMsg.includes('storage')) {
          errorCategory = 'STORAGE_ERROR';
          userMessage = 'Failed to save processed files to Supabase storage.';
          troubleshooting = [
            'Check your internet connection',
            'Verify Supabase storage buckets exist and are accessible',
            'Check storage quota limits',
            'Retry the upload after a few minutes'
          ];
        } else if (errorMsg.includes('knowledge base') || errorMsg.includes('database')) {
          errorCategory = 'DATABASE_ERROR';
          userMessage = 'Failed to save document information to the database.';
          troubleshooting = [
            'Check database connection and permissions',
            'Verify user authentication is valid',
            'Check if the database schema is up to date',
            'Retry the operation after a few minutes'
          ];
        }
      }
      
      await supabase
        .from('pdf_processing_results')
        .update({
          processing_status: 'failed',
          processing_completed_at: new Date().toISOString(),
          error_message: `${errorCategory}: ${userMessage} | Technical: ${technicalDetails}`,
          processing_time_ms: Date.now() - startTime
        })
        .eq('id', processingId);

      return new Response(
        JSON.stringify({
          success: false,
          error: userMessage,
          errorCategory: errorCategory,
          technicalDetails: technicalDetails,
          troubleshooting: troubleshooting,
          timestamp: new Date().toISOString(),
          processingId,
          context: 'convertapi_processing_step',
          debugInfo: {
            step: 'PDF processing pipeline',
            hasConvertApiKey: !!convertApiKey,
            hasOpenAiKey: !!openaiApiKey,
            processingTimeMs: Date.now() - startTime
          }
        }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    } catch (error) {
      console.error('❌ Top-level error in ConvertAPI PDF processor:', error);
      console.error('Error details:', {
        name: error instanceof Error ? error.name : 'Unknown',
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        timestamp: new Date().toISOString()
      });
      
      // Categorize the error for better user guidance
      let errorCategory = 'UNKNOWN_ERROR';
      let userMessage = 'An unexpected error occurred during PDF processing.';
      let troubleshooting: string[] = [];
      let technicalDetails = error instanceof Error ? error.message : String(error);

      if (error instanceof Error) {
        const errorMsg = error.message.toLowerCase();
        
        if (errorMsg.includes('convertapi_key') || errorMsg.includes('convertapi key')) {
          errorCategory = 'API_KEY_MISSING';
          userMessage = 'ConvertAPI key is not configured properly.';
          troubleshooting = [
            'Check that CONVERTAPI_KEY is set in Supabase Edge Function secrets',
            'Verify the API key is valid and has sufficient credits',
            'Contact your administrator to configure the API key'
          ];
        } else if (errorMsg.includes('convertapi request failed')) {
          errorCategory = 'CONVERTAPI_REQUEST_FAILED';
          userMessage = 'ConvertAPI service request failed.';
          troubleshooting = [
            'Check if the PDF file is valid and not corrupted',
            'Verify the file is not password protected',
            'Try with a smaller PDF file (under 10MB)',
            'Check ConvertAPI service status and credits'
          ];
        } else if (errorMsg.includes('upload') || errorMsg.includes('storage')) {
          errorCategory = 'STORAGE_ERROR';
          userMessage = 'Failed to upload or store files in Supabase storage.';
          troubleshooting = [
            'Check your internet connection',
            'Verify Supabase storage buckets are properly configured',
            'Try uploading a smaller file',
            'Check if you have sufficient storage quota'
          ];
        } else if (errorMsg.includes('embedding') || errorMsg.includes('openai')) {
          errorCategory = 'EMBEDDING_ERROR';
          userMessage = 'Failed to generate embeddings for the document.';
          troubleshooting = [
            'Check OpenAI API key configuration',
            'Verify OpenAI API quota and billing',
            'Try processing a smaller document',
            'Check if the extracted text is valid'
          ];
        } else if (errorMsg.includes('knowledge base') || errorMsg.includes('database')) {
          errorCategory = 'DATABASE_ERROR';
          userMessage = 'Failed to save document to the knowledge base.';
          troubleshooting = [
            'Check database connection',
            'Verify user permissions',
            'Check if the document data is valid',
            'Try processing again after a few minutes'
          ];
        } else if (errorMsg.includes('memory') || errorMsg.includes('limit')) {
          errorCategory = 'MEMORY_LIMIT';
          userMessage = 'Document is too large and exceeded memory limits.';
          troubleshooting = [
            'Try processing a smaller PDF file (under 5MB)',
            'Split large documents into smaller sections',
            'Reduce the page range for processing',
            'Contact support for processing large documents'
          ];
        } else if (errorMsg.includes('timeout') || errorMsg.includes('time')) {
          errorCategory = 'TIMEOUT_ERROR';
          userMessage = 'Processing timed out due to document complexity.';
          troubleshooting = [
            'Try processing a simpler PDF document',
            'Reduce the number of pages to process',
            'Retry the operation',
            'Contact support for complex documents'
          ];
        }
      }
      
      return new Response(
        JSON.stringify({ 
          success: false,
          error: userMessage,
          errorCategory: errorCategory,
          technicalDetails: technicalDetails,
          troubleshooting: troubleshooting,
          timestamp: new Date().toISOString(),
          context: 'convertapi_initialization_error',
          // Additional debug info
          debugInfo: {
            errorType: error instanceof Error ? error.name : typeof error,
            hasConvertApiKey: !!convertApiKey,
            hasOpenAiKey: !!openaiApiKey,
            requestMethod: 'POST',
            functionName: 'convertapi-pdf-processor'
          }
        }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }
});