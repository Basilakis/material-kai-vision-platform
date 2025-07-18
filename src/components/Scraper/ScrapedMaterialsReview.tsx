import React, { useState, useEffect } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/hooks/use-toast';
import { supabase } from '@/integrations/supabase/client';
import { 
  Check, 
  X, 
  Eye, 
  Trash2, 
  Download, 
  Loader2,
  Clock,
  ExternalLink,
  Search,
  AlertCircle
} from 'lucide-react';

interface ScrapedMaterial {
  name: string;
  description?: string;
  category?: string;
  price?: string;
  images: string[];
  properties: Record<string, any>;
  sourceUrl: string;
  supplier?: string;
}

interface ScrapedMaterialTemp {
  id: string;
  material_data: any; // Use any since it comes from database as Json type
  source_url: string;
  scraped_at: string;
  reviewed: boolean;
  approved: boolean | null;
  notes: string | null;
  scraping_session_id: string;
}

interface ScrapedMaterialsReviewProps {
  sessionId?: string | null;
  currentResults?: ScrapedMaterial[];
  onMaterialsUpdate?: (materials: ScrapedMaterial[]) => void;
  onAddAllToCatalog?: () => void;
  isLoading?: boolean;
  onContinueScraping?: (sessionId: string) => void;
  onRetryScraping?: () => void;
}

export const ScrapedMaterialsReview: React.FC<ScrapedMaterialsReviewProps> = ({
  sessionId,
  currentResults = [],
  onMaterialsUpdate,
  onAddAllToCatalog,
  isLoading = false,
  onContinueScraping,
  onRetryScraping
}) => {
  const { toast } = useToast();
  const [materials, setMaterials] = useState<ScrapedMaterialTemp[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedMaterials, setSelectedMaterials] = useState<Set<string>>(new Set());
  const [bulkAction, setBulkAction] = useState<'approve' | 'reject' | 'delete' | null>(null);
  const [sessionStats, setSessionStats] = useState<{
    totalProcessed: number;
    totalExpected: number;
    isActive: boolean;
    currentUrl?: string;
    startedAt?: string;
    estimatedTimeRemaining?: number;
  } | null>(null);
  const [scrapingStatus, setScrapingStatus] = useState<'idle' | 'active' | 'paused' | 'completed' | 'error'>('idle');

  useEffect(() => {
    if (sessionId && currentResults.length === 0) {
      loadMaterialsBySession(sessionId);
      checkActiveSession(sessionId);
    } else if (currentResults.length === 0) {
      loadAllUnreviewedMaterials(0, 50);
      checkForActiveSessions();
    }

    // Set up real-time subscription for new materials
    const channel = supabase
      .channel('scraped-materials-changes')
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'scraped_materials_temp'
        },
        (payload) => {
          console.log('New material scraped:', payload);
          const newMaterial = payload.new as ScrapedMaterialTemp;
          
          // Add new material to the list if it matches our current session or if we're viewing all
          if (!sessionId || newMaterial.scraping_session_id === sessionId) {
            setMaterials(prev => [newMaterial, ...prev]);
            setScrapingStatus('active');
            
            // Update session stats with enhanced progress tracking
            setSessionStats(prev => {
              const newStats = prev ? {
                ...prev,
                totalProcessed: prev.totalProcessed + 1,
                currentUrl: newMaterial.source_url,
                estimatedTimeRemaining: prev.totalExpected > prev.totalProcessed + 1 ? 
                  ((Date.now() - new Date(prev.startedAt || Date.now()).getTime()) / (prev.totalProcessed + 1)) * 
                  (prev.totalExpected - prev.totalProcessed - 1) / 1000 : 0
              } : {
                totalProcessed: 1,
                totalExpected: 1,
                isActive: true,
                currentUrl: newMaterial.source_url,
                startedAt: new Date().toISOString(),
                estimatedTimeRemaining: 0
              };
              
              // Check if scraping is completed
              if (newStats.totalProcessed >= newStats.totalExpected) {
                setScrapingStatus('completed');
                setTimeout(() => setScrapingStatus('idle'), 3000);
              }
              
              return newStats;
            });
          }
        }
      )
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'scraping_sessions'
        },
        (payload) => {
          console.log('Scraping session updated:', payload);
          const sessionData = payload.new as any;
          
          if (sessionData.session_id === sessionId) {
            if (sessionData.status === 'active') {
              setScrapingStatus('active');
            } else if (sessionData.status === 'completed') {
              setScrapingStatus('completed');
              setTimeout(() => setScrapingStatus('idle'), 3000);
            } else if (sessionData.status === 'error') {
              setScrapingStatus('error');
            }
          }
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [sessionId, currentResults.length]);

  const loadMoreMaterials = () => {
    if (sessionStats && materials.length < sessionStats.totalExpected) {
      loadAllUnreviewedMaterials(materials.length, 50);
    }
  };

  const loadMaterialsBySession = async (sessionId: string) => {
    setLoading(true);
    try {
      // First, get the UUID for this session
      const { data: sessionData, error: sessionError } = await supabase
        .from('scraping_sessions')
        .select('id')
        .eq('session_id', sessionId)
        .single();

      if (sessionError) {
        console.error('Error finding session:', sessionError);
        throw sessionError;
      }

      if (!sessionData) {
        throw new Error('Session not found');
      }

      // Now query scraped materials using the UUID
      const { data, error } = await supabase
        .from('scraped_materials_temp')
        .select('*')
        .eq('scraping_session_id', sessionData.id)
        .order('scraped_at', { ascending: false });

      if (error) throw error;
      setMaterials((data || []) as ScrapedMaterialTemp[]);
      console.log('Loaded materials by session:', sessionId, 'Count:', data?.length || 0);
      
      // Check for session progress info from latest material
      if (data && data.length > 0) {
        const latestMaterial = data[0];
        const materialData = latestMaterial.material_data as any;
        if (materialData?.metadata?.sessionProgress) {
          const progress = materialData.metadata.sessionProgress;
          setSessionStats({
            totalProcessed: data.length,
            totalExpected: progress.totalExpected || data.length,
            isActive: progress.isActive || false,
            currentUrl: progress.currentUrl,
            startedAt: progress.startedAt || latestMaterial.scraped_at,
            estimatedTimeRemaining: progress.estimatedTimeRemaining || 0
          });
          
          setScrapingStatus(progress.isActive ? 'active' : 'idle');
        } else {
          setSessionStats({
            totalProcessed: data.length,
            totalExpected: data.length,
            isActive: false,
            startedAt: latestMaterial.scraped_at
          });
        }
      }
    } catch (error) {
      console.error('Error loading materials by session:', error);
      toast({
        title: "Error",
        description: "Failed to load scraped materials",
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  };

  const loadAllUnreviewedMaterials = async (offset = 0, limit = 50) => {
    setLoading(true);
    console.log('Loading all unreviewed materials...', { offset, limit });
    try {
      const { data, error } = await supabase
        .from('scraped_materials_temp')
        .select('*')
        .eq('reviewed', false)
        .order('scraped_at', { ascending: false })
        .range(offset, offset + limit - 1);

      if (error) throw error;
      
      if (offset === 0) {
        setMaterials((data || []) as ScrapedMaterialTemp[]);
      } else {
        setMaterials(prev => [...prev, ...((data || []) as ScrapedMaterialTemp[])]);
      }
      
      console.log('Loaded unreviewed materials count:', data?.length || 0);
      
      // Get total count for progress
      const { count } = await supabase
        .from('scraped_materials_temp')
        .select('*', { count: 'exact', head: true })
        .eq('reviewed', false);
        
      if (count !== null) {
        setSessionStats({
          totalProcessed: offset + (data?.length || 0),
          totalExpected: count,
          isActive: false,
          startedAt: data && data.length > 0 ? data[data.length - 1].scraped_at : new Date().toISOString()
        });
        setScrapingStatus('idle');
      }
    } catch (error) {
      console.error('Error loading unreviewed materials:', error);
      toast({
        title: "Error",
        description: "Failed to load unreviewed materials",
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  };

  const checkActiveSession = async (sessionId: string) => {
    try {
      const { data, error } = await supabase
        .from('scraping_sessions')
        .select('*')
        .eq('session_id', sessionId)
        .eq('status', 'active')
        .single();

      if (error || !data) {
        console.log('No active session found for:', sessionId);
        return;
      }

      console.log('Found active session:', data);
      setScrapingStatus('active');
      setSessionStats({
        totalProcessed: data.materials_processed || 0,
        totalExpected: data.total_materials_found || 100, // Default expectation
        isActive: true,
        currentUrl: data.source_url,
        startedAt: data.created_at
      });
    } catch (error) {
      console.error('Error checking active session:', error);
    }
  };

  const checkForActiveSessions = async () => {
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) return;

      const { data, error } = await supabase
        .from('scraping_sessions')
        .select('*')
        .eq('user_id', session.user.id)
        .eq('status', 'active')
        .order('created_at', { ascending: false })
        .limit(1);

      if (error || !data || data.length === 0) {
        console.log('No active sessions found');
        setScrapingStatus('idle');
        return;
      }

      const activeSession = data[0];
      console.log('Found active session:', activeSession);
      setScrapingStatus('active');
      setSessionStats({
        totalProcessed: activeSession.materials_processed || 0,
        totalExpected: activeSession.total_materials_found || 100,
        isActive: true,
        currentUrl: activeSession.source_url,
        startedAt: activeSession.created_at
      });
    } catch (error) {
      console.error('Error checking for active sessions:', error);
    }
  };

  const updateMaterialReview = async (
    materialId: string, 
    approved: boolean | null, 
    notes?: string
  ) => {
    try {
      const { error } = await supabase
        .from('scraped_materials_temp')
        .update({
          reviewed: true,
          approved: approved,
          notes: notes || null,
          updated_at: new Date().toISOString()
        })
        .eq('id', materialId);

      if (error) throw error;

      // Update local state
      setMaterials(prev => prev.map(material => 
        material.id === materialId 
          ? { ...material, reviewed: true, approved, notes: notes || null }
          : material
      ));

      toast({
        title: "Success",
        description: `Material ${approved === true ? 'approved' : approved === false ? 'rejected' : 'reviewed'}`,
      });
    } catch (error) {
      console.error('Error updating material review:', error);
      toast({
        title: "Error",
        description: "Failed to update material review",
        variant: "destructive",
      });
    }
  };

  const deleteMaterial = async (materialId: string) => {
    try {
      const { error } = await supabase
        .from('scraped_materials_temp')
        .delete()
        .eq('id', materialId);

      if (error) throw error;

      setMaterials(prev => prev.filter(material => material.id !== materialId));
      setSelectedMaterials(prev => {
        const newSet = new Set(prev);
        newSet.delete(materialId);
        return newSet;
      });

      toast({
        title: "Success",
        description: "Material deleted",
      });
    } catch (error) {
      console.error('Error deleting material:', error);
      toast({
        title: "Error",
        description: "Failed to delete material",
        variant: "destructive",
      });
    }
  };

  const addApprovedToCatalog = async () => {
    const approvedMaterials = materials.filter(m => m.approved === true);
    if (approvedMaterials.length === 0) {
      toast({
        title: "No approved materials",
        description: "Please approve some materials before adding to catalog",
        variant: "destructive",
      });
      return;
    }

    setLoading(true);
    try {
      let successCount = 0;
      
      for (const material of approvedMaterials) {
        const materialData = material.material_data;
        
        try {
          const { error } = await supabase.from('materials_catalog').insert({
            name: materialData.name,
            description: materialData.description || 'Scraped and reviewed material',
            category: (materialData.category?.toLowerCase() as any) || 'other',
            properties: {
              ...materialData.properties,
              price: materialData.price,
              images: materialData.images || [],
              sourceUrl: materialData.sourceUrl,
              supplier: materialData.supplier,
              scrapedAt: material.scraped_at,
              reviewedAt: new Date().toISOString(),
              notes: material.notes
            },
            thumbnail_url: materialData.images?.[0] || null
          });
          
          if (!error) {
            successCount++;
            // Mark as processed by deleting from temp table
            await supabase
              .from('scraped_materials_temp')
              .delete()
              .eq('id', material.id);
          }
        } catch (err) {
          console.error('Failed to add material to catalog:', materialData.name, err);
        }
      }

      // Update local state to remove added materials
      setMaterials(prev => prev.filter(m => m.approved !== true));
      setSelectedMaterials(new Set());

      toast({
        title: "Success",
        description: `Added ${successCount} approved materials to catalog`,
      });
    } catch (error) {
      console.error('Error adding to catalog:', error);
      toast({
        title: "Error",
        description: "Failed to add materials to catalog",
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  };

  const handleBulkAction = async () => {
    if (!bulkAction || selectedMaterials.size === 0) return;

    const selectedIds = Array.from(selectedMaterials);
    
    try {
      switch (bulkAction) {
        case 'approve':
          for (const id of selectedIds) {
            await updateMaterialReview(id, true);
          }
          break;
        case 'reject':
          for (const id of selectedIds) {
            await updateMaterialReview(id, false);
          }
          break;
        case 'delete':
          for (const id of selectedIds) {
            await deleteMaterial(id);
          }
          break;
      }
      
      setSelectedMaterials(new Set());
      setBulkAction(null);
    } catch (error) {
      console.error('Bulk action error:', error);
    }
  };

  const clearAllReviewData = async () => {
    try {
      setLoading(true);
      
      // Get current user's data only
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        toast({
          title: "Error",
          description: "You must be logged in to clear review data",
          variant: "destructive",
        });
        return;
      }

      // Delete all scraped materials for this user
      const { error } = await supabase
        .from('scraped_materials_temp')
        .delete()
        .eq('user_id', session.user.id);

      if (error) throw error;

      // Clear scraping sessions
      await supabase
        .from('scraping_sessions')
        .delete()
        .eq('user_id', session.user.id);

      // Clear local state
      setMaterials([]);
      setSelectedMaterials(new Set());
      setSessionStats(null);

      toast({
        title: "Success",
        description: "All review data cleared successfully",
      });
    } catch (error) {
      console.error('Error clearing review data:', error);
      toast({
        title: "Error",
        description: "Failed to clear review data",
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  };

  const toggleMaterialSelection = (materialId: string) => {
    setSelectedMaterials(prev => {
      const newSet = new Set(prev);
      if (newSet.has(materialId)) {
        newSet.delete(materialId);
      } else {
        newSet.add(materialId);
      }
      return newSet;
    });
  };

  // Show current results first if available, otherwise show stored materials
  const displayMaterials = currentResults.length > 0 ? currentResults : materials;
  const showCurrentResults = currentResults.length > 0;

  const approvedCount = materials.filter(m => m.approved === true).length;
  const rejectedCount = materials.filter(m => m.approved === false).length;
  const unreviewedCount = materials.filter(m => !m.reviewed).length;

  if (loading && materials.length === 0 && currentResults.length === 0) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center py-8">
          <Loader2 className="h-6 w-6 animate-spin mr-2" />
          <span>Loading materials for review...</span>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Search className="h-5 w-5" />
          {showCurrentResults ? `Current Results (${currentResults.length})` : `Review Materials (${materials.length})`}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="space-y-4">
          {/* Debug Information */}
          <div className="text-xs text-muted-foreground p-2 bg-muted/30 rounded">
            Debug: Status = {scrapingStatus} | Session Active = {sessionStats?.isActive ? 'Yes' : 'No'} | Materials = {materials.length}
          </div>
          
          <div className="flex gap-2 flex-wrap">
            {showCurrentResults && onAddAllToCatalog && (
              <Button
                onClick={onAddAllToCatalog}
                disabled={isLoading}
                size="sm"
              >
                {isLoading ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    Adding...
                  </>
                ) : (
                  <>Add All to Catalog</>
                )}
              </Button>
            )}
            
            <Button
              onClick={() => loadAllUnreviewedMaterials(0, 50)}
              disabled={loading}
              variant="outline"
              size="sm"
            >
              {loading ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Loading...
                </>
              ) : (
                <>Load Stored Materials</>
              )}
            </Button>
            
            {sessionId && (
              <Button
                onClick={() => loadMaterialsBySession(sessionId)}
                disabled={loading}
                variant="outline"
                size="sm"
              >
                Refresh Session
              </Button>
            )}

            {sessionStats && sessionStats.isActive && sessionId && onContinueScraping && (
              <Button
                onClick={() => onContinueScraping(sessionId)}
                disabled={loading}
                variant="default"
                size="sm"
                className="text-blue-600 border-blue-600"
              >
                Continue Scraping
              </Button>
            )}

            {onRetryScraping && (
              <Button
                onClick={onRetryScraping}
                disabled={loading}
                variant="outline"
                size="sm"
                className="text-orange-600"
              >
                Retry Process
              </Button>
            )}

            {sessionStats && sessionStats.totalExpected > materials.length && (
              <Button
                onClick={loadMoreMaterials}
                disabled={loading}
                variant="outline"
                size="sm"
              >
                {loading ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    Loading...
                  </>
                ) : (
                  <>Load More ({materials.length}/{sessionStats.totalExpected})</>
                )}
              </Button>
            )}

            {!showCurrentResults && materials.length > 0 && (
              <Button
                onClick={addApprovedToCatalog}
                disabled={loading || approvedCount === 0}
                size="sm"
                variant="outline"
              >
                {loading ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Download className="h-4 w-4 mr-2" />}
                Add {approvedCount} Approved to Catalog
              </Button>
            )}

            {materials.length > 0 && (
              <Button
                onClick={clearAllReviewData}
                disabled={loading}
                size="sm"
                variant="destructive"
                className="ml-auto"
              >
                {loading ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Trash2 className="h-4 w-4 mr-2" />}
                Clear All Review
              </Button>
            )}
          </div>

          {/* Scraping Status Indicator */}
          {(scrapingStatus === 'active' || sessionStats?.isActive) && (
            <Card className="mb-4 border-blue-200 bg-blue-50 dark:bg-blue-950/30">
              <CardContent className="p-4">
                <div className="flex items-center gap-3 mb-3">
                  <div className="flex items-center gap-2">
                    <div className="h-3 w-3 bg-blue-500 rounded-full animate-pulse"></div>
                    <h3 className="font-medium text-blue-800 dark:text-blue-200">
                      Active Scraping in Progress
                    </h3>
                  </div>
                  <Badge variant="secondary" className="bg-blue-100 text-blue-800 border-blue-200">
                    <Clock className="h-3 w-3 mr-1" />
                    Live
                  </Badge>
                </div>
                
                {sessionStats?.currentUrl && (
                  <div className="text-sm text-blue-700 dark:text-blue-300 mb-2 font-mono bg-white/50 dark:bg-blue-900/30 p-2 rounded truncate">
                    Currently processing: {sessionStats.currentUrl}
                  </div>
                )}
                
                <div className="flex items-center justify-between text-sm text-blue-700 dark:text-blue-300 mb-2">
                  <span>Progress: {sessionStats?.totalProcessed || 0} of {sessionStats?.totalExpected || 0} materials</span>
                  {sessionStats?.estimatedTimeRemaining && sessionStats.estimatedTimeRemaining > 0 && (
                    <span>~{Math.ceil(sessionStats.estimatedTimeRemaining / 60)} min remaining</span>
                  )}
                </div>
                
                <div className="w-full bg-blue-200 dark:bg-blue-800 rounded-full h-2 overflow-hidden">
                  <div 
                    className="bg-blue-500 h-2 rounded-full transition-all duration-500 animate-fade-in" 
                    style={{ 
                      width: `${sessionStats ? Math.min((sessionStats.totalProcessed / sessionStats.totalExpected) * 100, 100) : 0}%` 
                    }}
                  />
                </div>
                
                <div className="mt-3 text-xs text-blue-600 dark:text-blue-400">
                  💡 New materials will appear automatically as they are discovered and processed
                </div>
              </CardContent>
            </Card>
          )}

          {/* Completion Status */}
          {scrapingStatus === 'completed' && (
            <Card className="mb-4 border-green-200 bg-green-50 dark:bg-green-950/30 animate-fade-in">
              <CardContent className="p-4">
                <div className="flex items-center gap-2 text-green-800 dark:text-green-200">
                  <Check className="h-5 w-5" />
                  <h3 className="font-medium">Scraping Completed Successfully!</h3>
                </div>
                <p className="text-sm text-green-700 dark:text-green-300 mt-1">
                  All materials have been processed and are ready for review.
                </p>
              </CardContent>
            </Card>
          )}

          {/* Error Status */}
          {scrapingStatus === 'error' && (
            <Card className="mb-4 border-red-200 bg-red-50 dark:bg-red-950/30">
              <CardContent className="p-4">
                <div className="flex items-center gap-2 text-red-800 dark:text-red-200">
                  <AlertCircle className="h-5 w-5" />
                  <h3 className="font-medium">Scraping Error</h3>
                </div>
                <p className="text-sm text-red-700 dark:text-red-300 mt-1">
                  There was an issue with the scraping process. You can try to continue or retry the process.
                </p>
              </CardContent>
            </Card>
          )}

          {/* Progress and Summary Stats */}
          {sessionStats && !sessionStats.isActive && scrapingStatus !== 'active' && (
            <Card className="mb-4">
              <CardContent className="p-4">
                <div className="flex items-center justify-between mb-2">
                  <h3 className="font-medium">Session Summary</h3>
                  <Badge variant="outline" className="text-muted-foreground">
                    Completed
                  </Badge>
                </div>
                <div className="text-sm text-muted-foreground mb-2">
                  {sessionStats.totalProcessed} of {sessionStats.totalExpected} materials processed
                  {sessionStats.startedAt && (
                    <span className="ml-2">
                      • Started {new Date(sessionStats.startedAt).toLocaleString()}
                    </span>
                  )}
                </div>
                <div className="w-full bg-muted rounded-full h-2">
                  <div 
                    className="bg-primary h-2 rounded-full transition-all duration-300" 
                    style={{ 
                      width: `${Math.min((sessionStats.totalProcessed / sessionStats.totalExpected) * 100, 100)}%` 
                    }}
                  />
                </div>
              </CardContent>
            </Card>
          )}

          {/* Summary Stats for stored materials */}
          {!showCurrentResults && materials.length > 0 && (
            <div className="grid grid-cols-4 gap-4">
              <Card>
                <CardContent className="p-4">
                  <div className="text-2xl font-bold">{materials.length}</div>
                  <div className="text-sm text-muted-foreground">Loaded Materials</div>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="p-4">
                  <div className="text-2xl font-bold text-green-600">{approvedCount}</div>
                  <div className="text-sm text-muted-foreground">Approved</div>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="p-4">
                  <div className="text-2xl font-bold text-red-600">{rejectedCount}</div>
                  <div className="text-sm text-muted-foreground">Rejected</div>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="p-4">
                  <div className="text-2xl font-bold text-orange-600">{unreviewedCount}</div>
                  <div className="text-sm text-muted-foreground">Unreviewed</div>
                </CardContent>
              </Card>
            </div>
          )}

          {/* Bulk Actions for stored materials */}
          {!showCurrentResults && selectedMaterials.size > 0 && (
            <Card>
              <CardContent className="p-4">
                <div className="flex items-center gap-4">
                  <span className="text-sm">
                    {selectedMaterials.size} material(s) selected
                  </span>
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setBulkAction('approve')}
                      className="text-green-600"
                    >
                      <Check className="h-4 w-4 mr-1" />
                      Approve Selected
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setBulkAction('reject')}
                      className="text-red-600"
                    >
                      <X className="h-4 w-4 mr-1" />
                      Reject Selected
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setBulkAction('delete')}
                      className="text-destructive"
                    >
                      <Trash2 className="h-4 w-4 mr-1" />
                      Delete Selected
                    </Button>
                  </div>
                  {bulkAction && (
                    <Button
                      size="sm"
                      onClick={handleBulkAction}
                      disabled={loading}
                    >
                      Confirm {bulkAction}
                    </Button>
                  )}
                </div>
              </CardContent>
            </Card>
          )}

          {displayMaterials.length > 0 ? (
            <div className="space-y-4">
              <div className="flex justify-between items-center">
                <p className="text-sm text-muted-foreground">
                  {showCurrentResults 
                    ? `Current results: ${currentResults.length} materials`
                    : `Found ${materials.length} stored materials for review`
                  }
                </p>
              </div>
              
              <div className="grid gap-4">
                {displayMaterials.map((material, index) => {
                  // Handle both current results and stored materials formats
                  const materialData = material.material_data || material;
                  const isStored = !!material.id;
                  
                  return (
                    <div key={material.id || index} className="p-4 border rounded-lg space-y-3">
                      <div className="flex justify-between items-start">
                        <div className="flex items-start gap-3">
                          {isStored && (
                            <Checkbox
                              checked={selectedMaterials.has(material.id)}
                              onCheckedChange={() => toggleMaterialSelection(material.id)}
                            />
                          )}
                          <div className="flex-1">
                            <h3 className="font-medium">{materialData.name}</h3>
                            <p className="text-sm text-muted-foreground">{materialData.description}</p>
                            <p className="text-xs text-muted-foreground mt-1">
                              Source: {material.source_url || materialData.sourceUrl}
                            </p>
                            {materialData.price && (
                              <p className="text-sm font-medium text-green-600">{materialData.price}</p>
                            )}
                          </div>
                        </div>
                        
                        {isStored && (
                          <div className="flex gap-2 ml-4">
                            <Button
                              onClick={() => updateMaterialReview(material.id, true)}
                              disabled={loading}
                              size="sm"
                              variant="outline"
                            >
                              <Check className="h-4 w-4 mr-1" />
                              Approve
                            </Button>
                            <Button
                              onClick={() => updateMaterialReview(material.id, false)}
                              disabled={loading}
                              size="sm"
                              variant="destructive"
                            >
                              <X className="h-4 w-4 mr-1" />
                              Reject
                            </Button>
                          </div>
                        )}
                      </div>
                      
                      {materialData.properties && (
                        <div className="text-xs bg-muted p-2 rounded">
                          <strong>Properties:</strong> {JSON.stringify(materialData.properties, null, 2)}
                        </div>
                      )}

                      {isStored && material.reviewed && (
                        <div className="flex items-center gap-2">
                          {material.approved === true && <Badge className="bg-green-600">Approved</Badge>}
                          {material.approved === false && <Badge variant="destructive">Rejected</Badge>}
                          {material.notes && (
                            <span className="text-xs text-muted-foreground">Notes: {material.notes}</span>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          ) : (
            <div className="text-center py-8 text-muted-foreground">
              <AlertCircle className="h-12 w-12 mx-auto mb-4 opacity-50" />
              <p>No materials to review. Run a scrape to see results here.</p>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
};