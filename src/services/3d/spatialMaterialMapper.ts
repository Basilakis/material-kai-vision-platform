import { supabase } from '@/integrations/supabase/client';

interface SpatialPoint {
  x: number;
  y: number;
  z: number;
  intensity?: number;
  color?: [number, number, number];
}

interface MaterialMapping {
  surfaceId: string;
  materialId: string;
  confidence: number;
  area: number;
  spatialBounds: {
    min: SpatialPoint;
    max: SpatialPoint;
  };
  averageColor: [number, number, number];
  textureFeatures: {
    roughness: number;
    reflectance: number;
    pattern: string;
  };
}

interface SpatialAnalysisResult {
  id: string;
  roomType: string;
  roomDimensions: {
    width: number;
    height: number;
    depth: number;
  };
  materialMappings: MaterialMapping[];
  spatialFeatures: {
    surfaces: Array<{
      id: string;
      type: 'wall' | 'floor' | 'ceiling' | 'furniture';
      area: number;
      normal: [number, number, number];
    }>;
    lighting: {
      sources: Array<{ position: SpatialPoint; intensity: number }>;
      ambientLevel: number;
    };
  };
  confidence: number;
}

export class SpatialMaterialMapper {
  async analyzeSpatialMaterials(
    pointCloudData: SpatialPoint[],
    roomType: string,
    userId: string
  ): Promise<string> {
    try {
      // Start spatial analysis job
      const { data: analysisJob, error } = await supabase
        .from('spatial_analysis')
        .insert({
          user_id: userId,
          room_type: roomType,
          status: 'processing',
          room_dimensions: this.calculateRoomDimensions(pointCloudData),
          spatial_features: this.extractSpatialFeatures(pointCloudData)
        })
        .select()
        .single();

      if (error) throw error;

      // Process point cloud in background
      this.processPointCloudAsync(analysisJob.id, pointCloudData);

      return analysisJob.id;
    } catch (error) {
      console.error('Error starting spatial analysis:', error);
      throw error;
    }
  }

  private async processPointCloudAsync(analysisId: string, pointCloudData: SpatialPoint[]): Promise<void> {
    try {
      // Segment surfaces from point cloud
      const surfaces = await this.segmentSurfaces(pointCloudData);
      
      // Extract material features for each surface
      const materialMappings: MaterialMapping[] = [];
      
      for (const surface of surfaces) {
        const materialFeatures = await this.extractMaterialFeatures(surface.points);
        const matchedMaterial = await this.matchMaterialFromFeatures(materialFeatures);
        
        if (matchedMaterial) {
          materialMappings.push({
            surfaceId: surface.id,
            materialId: matchedMaterial.id,
            confidence: matchedMaterial.confidence,
            area: surface.area,
            spatialBounds: surface.bounds,
            averageColor: materialFeatures.averageColor,
            textureFeatures: materialFeatures.textureFeatures
          });
        }
      }

      // Update analysis with results
      await supabase
        .from('spatial_analysis')
        .update({
          status: 'completed',
          material_placements: { mappings: materialMappings } as any,
          confidence_score: this.calculateOverallConfidence(materialMappings),
          processing_time_ms: Date.now() - new Date().getTime(),
          updated_at: new Date().toISOString()
        })
        .eq('id', analysisId);

      console.log(`Completed spatial analysis ${analysisId} with ${materialMappings.length} material mappings`);

    } catch (error) {
      console.error('Error processing point cloud:', error);
      
      await supabase
        .from('spatial_analysis')
        .update({
          status: 'failed',
          error_message: `Processing failed: ${error}`,
          updated_at: new Date().toISOString()
        })
        .eq('id', analysisId);
    }
  }

  private calculateRoomDimensions(pointCloudData: SpatialPoint[]): any {
    const minX = Math.min(...pointCloudData.map(p => p.x));
    const maxX = Math.max(...pointCloudData.map(p => p.x));
    const minY = Math.min(...pointCloudData.map(p => p.y));
    const maxY = Math.max(...pointCloudData.map(p => p.y));
    const minZ = Math.min(...pointCloudData.map(p => p.z));
    const maxZ = Math.max(...pointCloudData.map(p => p.z));

    return {
      width: maxX - minX,
      height: maxY - minY,
      depth: maxZ - minZ,
      bounds: {
        min: { x: minX, y: minY, z: minZ },
        max: { x: maxX, y: maxY, z: maxZ }
      }
    };
  }

  private extractSpatialFeatures(pointCloudData: SpatialPoint[]): any {
    // Extract key spatial features from point cloud
    const density = pointCloudData.length / this.calculateVolume(pointCloudData);
    
    return {
      pointCount: pointCloudData.length,
      density,
      colorVariance: this.calculateColorVariance(pointCloudData),
      geometricComplexity: this.calculateGeometricComplexity(pointCloudData)
    };
  }

  private async segmentSurfaces(pointCloudData: SpatialPoint[]): Promise<Array<{
    id: string;
    type: 'wall' | 'floor' | 'ceiling' | 'furniture';
    points: SpatialPoint[];
    area: number;
    bounds: { min: SpatialPoint; max: SpatialPoint };
    normal: [number, number, number];
  }>> {
    // Implement surface segmentation algorithm
    const surfaces: any[] = [];
    
    // Group points by height for floor/ceiling detection
    const floorPoints = pointCloudData.filter(p => p.y < -1.5);
    const ceilingPoints = pointCloudData.filter(p => p.y > 1.5);
    const wallPoints = pointCloudData.filter(p => p.y >= -1.5 && p.y <= 1.5);

    if (floorPoints.length > 100) {
      surfaces.push({
        id: 'floor',
        type: 'floor' as const,
        points: floorPoints,
        area: this.calculateSurfaceArea(floorPoints),
        bounds: this.calculateBounds(floorPoints),
        normal: [0, 1, 0] as [number, number, number]
      });
    }

    if (ceilingPoints.length > 100) {
      surfaces.push({
        id: 'ceiling',
        type: 'ceiling' as const,
        points: ceilingPoints,
        area: this.calculateSurfaceArea(ceilingPoints),
        bounds: this.calculateBounds(ceilingPoints),
        normal: [0, -1, 0] as [number, number, number]
      });
    }

    // Wall segmentation (simplified)
    const wallClusters = this.clusterWallPoints(wallPoints);
    wallClusters.forEach((cluster, index) => {
      surfaces.push({
        id: `wall_${index}`,
        type: 'wall' as const,
        points: cluster,
        area: this.calculateSurfaceArea(cluster),
        bounds: this.calculateBounds(cluster),
        normal: this.calculateSurfaceNormal(cluster)
      });
    });

    return surfaces;
  }

  private async extractMaterialFeatures(surfacePoints: SpatialPoint[]): Promise<{
    averageColor: [number, number, number];
    textureFeatures: {
      roughness: number;
      reflectance: number;
      pattern: string;
    };
  }> {
    // Calculate average color
    const colors = surfacePoints.filter(p => p.color).map(p => p.color!);
    const averageColor: [number, number, number] = colors.length > 0 ? [
      colors.reduce((sum, c) => sum + c[0], 0) / colors.length,
      colors.reduce((sum, c) => sum + c[1], 0) / colors.length,
      colors.reduce((sum, c) => sum + c[2], 0) / colors.length
    ] : [128, 128, 128];

    // Analyze texture features
    const roughness = this.calculateRoughness(surfacePoints);
    const reflectance = this.calculateReflectance(surfacePoints);
    const pattern = this.detectPattern(surfacePoints);

    return {
      averageColor,
      textureFeatures: {
        roughness,
        reflectance,
        pattern
      }
    };
  }

  private async matchMaterialFromFeatures(features: any): Promise<{ id: string; confidence: number } | null> {
    try {
      // Get materials from database for matching
      const { data: materials, error } = await supabase
        .from('materials_catalog')
        .select('id, name, properties');

      if (error) throw error;

      let bestMatch: { id: string; confidence: number } | null = null;
      let maxConfidence = 0;

      for (const material of materials || []) {
        const confidence = this.calculateMaterialMatchConfidence(features, material);
        if (confidence > maxConfidence && confidence > 0.6) {
          maxConfidence = confidence;
          bestMatch = { id: material.id, confidence };
        }
      }

      return bestMatch;
    } catch (error) {
      console.error('Error matching material:', error);
      return null;
    }
  }

  private calculateMaterialMatchConfidence(features: any, material: any): number {
    let confidence = 0;
    let factors = 0;

    // Color matching
    if (material.metadata?.color && features.averageColor) {
      const colorMatch = this.calculateColorSimilarity(features.averageColor, material.metadata.color);
      confidence += colorMatch * 0.4;
      factors += 0.4;
    }

    // Texture matching
    if (material.properties?.roughness !== undefined && features.textureFeatures.roughness !== undefined) {
      const roughnessMatch = 1 - Math.abs(material.properties.roughness - features.textureFeatures.roughness);
      confidence += roughnessMatch * 0.3;
      factors += 0.3;
    }

    // Pattern matching
    if (material.metadata?.pattern && features.textureFeatures.pattern) {
      const patternMatch = material.metadata.pattern === features.textureFeatures.pattern ? 1 : 0;
      confidence += patternMatch * 0.3;
      factors += 0.3;
    }

    return factors > 0 ? confidence / factors : 0;
  }

  // Helper methods
  private calculateVolume(points: SpatialPoint[]): number {
    const bounds = this.calculateBounds(points);
    return (bounds.max.x - bounds.min.x) * 
           (bounds.max.y - bounds.min.y) * 
           (bounds.max.z - bounds.min.z);
  }

  private calculateColorVariance(points: SpatialPoint[]): number {
    const colors = points.filter(p => p.color).map(p => p.color!);
    if (colors.length === 0) return 0;

    const avgColor = [
      colors.reduce((sum, c) => sum + c[0], 0) / colors.length,
      colors.reduce((sum, c) => sum + c[1], 0) / colors.length,
      colors.reduce((sum, c) => sum + c[2], 0) / colors.length
    ];

    const variance = colors.reduce((sum, color) => {
      const diff = Math.sqrt(
        Math.pow(color[0] - avgColor[0], 2) +
        Math.pow(color[1] - avgColor[1], 2) +
        Math.pow(color[2] - avgColor[2], 2)
      );
      return sum + diff;
    }, 0) / colors.length;

    return variance;
  }

  private calculateGeometricComplexity(points: SpatialPoint[]): number {
    // Simple complexity measure based on point distribution
    const bounds = this.calculateBounds(points);
    const volume = this.calculateVolume(points);
    const density = points.length / volume;
    
    return Math.min(density / 1000, 1); // Normalize to 0-1
  }

  private calculateSurfaceArea(points: SpatialPoint[]): number {
    // Simplified surface area calculation
    if (points.length < 3) return 0;
    
    const bounds = this.calculateBounds(points);
    return (bounds.max.x - bounds.min.x) * (bounds.max.z - bounds.min.z);
  }

  private calculateBounds(points: SpatialPoint[]): { min: SpatialPoint; max: SpatialPoint } {
    if (points.length === 0) {
      return { min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 } };
    }

    return {
      min: {
        x: Math.min(...points.map(p => p.x)),
        y: Math.min(...points.map(p => p.y)),
        z: Math.min(...points.map(p => p.z))
      },
      max: {
        x: Math.max(...points.map(p => p.x)),
        y: Math.max(...points.map(p => p.y)),
        z: Math.max(...points.map(p => p.z))
      }
    };
  }

  private clusterWallPoints(points: SpatialPoint[]): SpatialPoint[][] {
    // Simple clustering based on X and Z coordinates
    const clusters: SpatialPoint[][] = [];
    const visited = new Set<number>();

    for (let i = 0; i < points.length; i++) {
      if (visited.has(i)) continue;

      const cluster: SpatialPoint[] = [points[i]];
      visited.add(i);

      for (let j = i + 1; j < points.length; j++) {
        if (visited.has(j)) continue;

        const distance = Math.sqrt(
          Math.pow(points[i].x - points[j].x, 2) + 
          Math.pow(points[i].z - points[j].z, 2)
        );

        if (distance < 0.5) { // 50cm clustering threshold
          cluster.push(points[j]);
          visited.add(j);
        }
      }

      if (cluster.length > 50) { // Minimum cluster size
        clusters.push(cluster);
      }
    }

    return clusters;
  }

  private calculateSurfaceNormal(points: SpatialPoint[]): [number, number, number] {
    // Calculate surface normal using first three points
    if (points.length < 3) return [0, 0, 1];

    const p1 = points[0];
    const p2 = points[1];
    const p3 = points[2];

    const v1 = { x: p2.x - p1.x, y: p2.y - p1.y, z: p2.z - p1.z };
    const v2 = { x: p3.x - p1.x, y: p3.y - p1.y, z: p3.z - p1.z };

    const normal = {
      x: v1.y * v2.z - v1.z * v2.y,
      y: v1.z * v2.x - v1.x * v2.z,
      z: v1.x * v2.y - v1.y * v2.x
    };

    const length = Math.sqrt(normal.x * normal.x + normal.y * normal.y + normal.z * normal.z);
    
    return length > 0 ? [normal.x / length, normal.y / length, normal.z / length] : [0, 0, 1];
  }

  private calculateRoughness(points: SpatialPoint[]): number {
    // Calculate surface roughness based on point cloud variance
    if (points.length < 10) return 0.5;

    const avgY = points.reduce((sum, p) => sum + p.y, 0) / points.length;
    const variance = points.reduce((sum, p) => sum + Math.pow(p.y - avgY, 2), 0) / points.length;
    
    return Math.min(Math.sqrt(variance) * 10, 1); // Normalize to 0-1
  }

  private calculateReflectance(points: SpatialPoint[]): number {
    // Calculate reflectance based on intensity values
    const intensities = points.filter(p => p.intensity !== undefined).map(p => p.intensity!);
    if (intensities.length === 0) return 0.5;

    const avgIntensity = intensities.reduce((sum, i) => sum + i, 0) / intensities.length;
    return Math.min(avgIntensity / 255, 1); // Normalize to 0-1
  }

  private detectPattern(points: SpatialPoint[]): string {
    // Simple pattern detection based on point distribution
    const variance = this.calculateColorVariance(points);
    
    if (variance < 10) return 'solid';
    if (variance < 30) return 'subtle_texture';
    if (variance < 60) return 'textured';
    return 'patterned';
  }

  private calculateColorSimilarity(color1: [number, number, number], color2: string): number {
    // Convert color2 from string to RGB if needed
    // This is a simplified implementation
    const rgbColor2 = this.parseColorString(color2);
    if (!rgbColor2) return 0;

    const distance = Math.sqrt(
      Math.pow(color1[0] - rgbColor2[0], 2) +
      Math.pow(color1[1] - rgbColor2[1], 2) +
      Math.pow(color1[2] - rgbColor2[2], 2)
    );

    // Convert distance to similarity (0-1)
    return Math.max(0, 1 - distance / (255 * Math.sqrt(3)));
  }

  private parseColorString(colorStr: string): [number, number, number] | null {
    // Simple color parsing - extend as needed
    const colorMap: Record<string, [number, number, number]> = {
      'white': [255, 255, 255],
      'black': [0, 0, 0],
      'gray': [128, 128, 128],
      'red': [255, 0, 0],
      'green': [0, 255, 0],
      'blue': [0, 0, 255],
      'brown': [165, 42, 42],
      'beige': [245, 245, 220]
    };

    return colorMap[colorStr.toLowerCase()] || [128, 128, 128];
  }

  private calculateOverallConfidence(mappings: MaterialMapping[]): number {
    if (mappings.length === 0) return 0;
    
    const avgConfidence = mappings.reduce((sum, m) => sum + m.confidence, 0) / mappings.length;
    const coverageBonus = Math.min(mappings.length / 5, 0.2); // Bonus for covering more surfaces
    
    return Math.min(avgConfidence + coverageBonus, 1);
  }

  async getSpatialAnalysisResult(analysisId: string): Promise<SpatialAnalysisResult | null> {
    try {
      const { data, error } = await supabase
        .from('spatial_analysis')
        .select('*')
        .eq('id', analysisId)
        .single();

      if (error) throw error;

      return {
        id: data.id,
        roomType: data.room_type,
        roomDimensions: data.room_dimensions as any,
        materialMappings: (data.material_placements as any)?.mappings || [],
        spatialFeatures: data.spatial_features as any,
        confidence: data.confidence_score || 0
      };
    } catch (error) {
      console.error('Error getting spatial analysis result:', error);
      return null;
    }
  }
}