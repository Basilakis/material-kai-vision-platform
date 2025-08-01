import React, { useState, useCallback } from 'react';
import { Upload, FileText, Eye, Server, Cpu, Zap } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Progress } from '@/components/ui/progress';
import { useDropzone } from 'react-dropzone';
import { toast } from 'sonner';
import { HybridOCRService, HybridOCROptions, HybridOCRResult } from '@/services/ml';

export const OCRProcessor: React.FC = () => {
  const [isProcessing, setIsProcessing] = useState(false);
  const [ocrResult, setOcrResult] = useState<HybridOCRResult | null>(null);
  const [progress, setProgress] = useState(0);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [options, setOptions] = useState<HybridOCROptions>({
    language: 'en',
    extractStructuredData: true,
    documentType: 'general'
  });

  const onDrop = useCallback((acceptedFiles: File[]) => {
    if (acceptedFiles.length > 0) {
      setSelectedFile(acceptedFiles[0]);
      setOcrResult(null);
    }
  }, []);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: {
      'image/*': ['.jpg', '.jpeg', '.png', '.webp', '.bmp', '.tiff']
    },
    maxFiles: 1
  });

  const processOCR = async () => {
    if (!selectedFile) {
      toast.error('Please select an image file first');
      return;
    }

    setIsProcessing(true);
    setProgress(0);

    // Simulate progress
    const progressInterval = setInterval(() => {
      setProgress(prev => Math.min(prev + 10, 90));
    }, 200);

    try {
      const result = await (HybridOCRService as any).processOCR(selectedFile, options);
      
      clearInterval(progressInterval);
      setProgress(100);

      if (result.success && result.data) {
        setOcrResult(result.data as HybridOCRResult);
        toast.success(`OCR completed using ${result.data.processingMethod} processing`);
      } else {
        toast.error(result.error || 'OCR processing failed');
      }
    } catch (error) {
      clearInterval(progressInterval);
      toast.error('OCR processing failed');
      console.error('OCR Error:', error);
    } finally {
      setIsProcessing(false);
      setTimeout(() => setProgress(0), 1000);
    }
  };

  const [recommendation, setRecommendation] = useState<{
    method: 'client' | 'server' | 'hybrid';
    reason: string;
    estimatedTime: string;
    accuracy: string;
  } | null>(null);

  const getRecommendation = async () => {
    if (!selectedFile) {
      setRecommendation(null);
      return;
    }
    try {
      const rec = await HybridOCRService.getProcessingRecommendation(selectedFile, options);
      setRecommendation(rec);
    } catch (error) {
      console.error('Error getting recommendation:', error);
      setRecommendation(null);
    }
  };

  React.useEffect(() => {
    getRecommendation();
  }, [selectedFile, options]);

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <FileText className="h-5 w-5" />
            OCR Document Processing
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* File Upload */}
          <div
            {...getRootProps()}
            className={`border-2 border-dashed rounded-lg p-8 text-center cursor-pointer transition-colors ${
              isDragActive 
                ? 'border-primary bg-primary/5' 
                : 'border-border hover:border-primary/50'
            }`}
          >
            <input {...getInputProps()} />
            <Upload className="h-12 w-12 mx-auto mb-4 text-muted-foreground" />
            {selectedFile ? (
              <div>
                <p className="font-medium">{selectedFile.name}</p>
                <p className="text-sm text-muted-foreground">
                  {(selectedFile.size / 1024 / 1024).toFixed(2)} MB
                </p>
              </div>
            ) : (
              <div>
                <p className="text-lg font-medium mb-2">Drop image here or click to browse</p>
                <p className="text-sm text-muted-foreground">
                  Supports JPG, PNG, WebP, TIFF formats
                </p>
              </div>
            )}
          </div>

          {/* Processing Options */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="language">Language</Label>
              <Select 
                value={options.language} 
                onValueChange={(value) => setOptions(prev => ({ ...prev, language: value }))}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select language" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="en">English</SelectItem>
                  <SelectItem value="es">Spanish</SelectItem>
                  <SelectItem value="fr">French</SelectItem>
                  <SelectItem value="de">German</SelectItem>
                  <SelectItem value="it">Italian</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label htmlFor="documentType">Document Type</Label>
              <Select 
                value={options.documentType} 
                onValueChange={(value: any) => setOptions(prev => ({ ...prev, documentType: value }))}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select document type" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="general">General Document</SelectItem>
                  <SelectItem value="certificate">Certificate</SelectItem>
                  <SelectItem value="label">Product Label</SelectItem>
                  <SelectItem value="specification">Specification Sheet</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="flex items-center space-x-2">
            <Switch
              id="structured-data"
              checked={options.extractStructuredData}
              onCheckedChange={(checked) => setOptions(prev => ({ ...prev, extractStructuredData: checked }))}
            />
            <Label htmlFor="structured-data">Extract structured data</Label>
          </div>

          {/* Processing Recommendation */}
          {recommendation && (
            <Card className="bg-muted/50">
              <CardContent className="p-4">
                <div className="flex items-center gap-2 mb-2">
                  {recommendation.method === 'client' && <Cpu className="h-4 w-4 text-blue-500" />}
                  {recommendation.method === 'server' && <Server className="h-4 w-4 text-green-500" />}
                  {recommendation.method === 'hybrid' && <Zap className="h-4 w-4 text-purple-500" />}
                  <span className="font-medium">Recommended: {recommendation.method} processing</span>
                </div>
                <p className="text-sm text-muted-foreground mb-2">{recommendation.reason}</p>
                <div className="flex gap-4 text-xs">
                  <span>Est. time: {recommendation.estimatedTime}</span>
                  <span>Accuracy: {recommendation.accuracy}</span>
                </div>
              </CardContent>
            </Card>
          )}

          {/* Process Button */}
          <Button 
            onClick={processOCR} 
            disabled={!selectedFile || isProcessing}
            className="w-full"
          >
            {isProcessing ? 'Processing OCR...' : 'Extract Text'}
          </Button>

          {/* Progress Bar */}
          {isProcessing && (
            <Progress value={progress} className="w-full" />
          )}
        </CardContent>
      </Card>

      {/* Results */}
      {ocrResult && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Eye className="h-5 w-5" />
              OCR Results
              <Badge variant="secondary">
                {ocrResult.processingMethod} processing
              </Badge>
              {ocrResult.fallbackUsed && (
                <Badge variant="outline">Fallback used</Badge>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <Tabs defaultValue="text" className="w-full">
              <TabsList className="grid w-full grid-cols-3">
                <TabsTrigger value="text">Extracted Text</TabsTrigger>
                <TabsTrigger value="structured">Structured Data</TabsTrigger>
                <TabsTrigger value="metadata">Metadata</TabsTrigger>
              </TabsList>
              
              <TabsContent value="text" className="space-y-4">
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <Badge variant="outline">
                      Confidence: {Math.round(ocrResult.confidence * 100)}%
                    </Badge>
                    {ocrResult.language && (
                      <Badge variant="outline">
                        Language: {ocrResult.language}
                      </Badge>
                    )}
                  </div>
                  <div className="bg-muted p-4 rounded-lg">
                    <pre className="whitespace-pre-wrap text-sm">{ocrResult.text}</pre>
                  </div>
                </div>
              </TabsContent>
              
              <TabsContent value="structured" className="space-y-4">
                {ocrResult.structuredData ? (
                  <div className="bg-muted p-4 rounded-lg">
                    <pre className="text-sm">
                      {JSON.stringify(ocrResult.structuredData, null, 2)}
                    </pre>
                  </div>
                ) : (
                  <p className="text-muted-foreground">No structured data extracted</p>
                )}
              </TabsContent>
              
              <TabsContent value="metadata" className="space-y-4">
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <Label>Processing Method</Label>
                    <p className="text-sm font-medium">{ocrResult.processingMethod}</p>
                  </div>
                  <div>
                    <Label>Processing Time</Label>
                    <p className="text-sm font-medium">{ocrResult.processingTime}ms</p>
                  </div>
                  <div>
                    <Label>Confidence Score</Label>
                    <p className="text-sm font-medium">{Math.round(ocrResult.confidence * 100)}%</p>
                  </div>
                  <div>
                    <Label>Document Type</Label>
                    <p className="text-sm font-medium">{ocrResult.documentType || 'General'}</p>
                  </div>
                  {ocrResult.blocks && (
                    <div className="col-span-2">
                      <Label>Text Blocks Detected</Label>
                      <p className="text-sm font-medium">{ocrResult.blocks.length} blocks</p>
                    </div>
                  )}
                  {ocrResult.recommendation && (
                    <div className="col-span-2">
                      <Label>Processing Recommendation</Label>
                      <p className="text-sm font-medium">{ocrResult.recommendation}</p>
                    </div>
                  )}
                </div>
              </TabsContent>
            </Tabs>
          </CardContent>
        </Card>
      )}
    </div>
  );
};