import React from 'react';
import { 
  Home, 
  Eye, 
  Archive, 
  Palette, 
  Grid3X3, 
  Brain, 
  Activity,
  Settings,
  Layers,
  Box,
  ScanText,
  Search,
  Globe
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Link, useLocation } from 'react-router-dom';

const navigationItems = [
  { id: 'dashboard', label: 'Dashboard', path: '/', icon: Home },
  { id: 'search', label: 'Search Hub', path: '/search-hub', icon: Search },
  { id: 'pdf', label: 'PDF Upload', path: '/pdf-processing', icon: ScanText },
  
  { id: 'moodboard', label: 'MoodBoards', path: '/moodboard', icon: Palette },
  { id: '3d', label: '3D Designer', path: '/3d', icon: Box },
  { id: 'scraper', label: 'Web Scraper', path: '/scraper', icon: Globe },
  { id: 'admin', label: 'Admin Panel', path: '/admin', icon: Settings },
];

export const Sidebar: React.FC = () => {
  const location = useLocation();
  
  const isActive = (path: string) => {
    if (path === '/') return location.pathname === '/';
    return location.pathname.startsWith(path);
  };

  return (
    <aside className="w-64 border-r bg-card min-h-screen">
      <nav className="p-4 space-y-2">
        {navigationItems.map((item) => (
          <Button
            key={item.id}
            variant={isActive(item.path) ? 'default' : 'ghost'}
            className="w-full justify-start"
            asChild
          >
            <Link to={item.path}>
              <item.icon className="w-4 h-4 mr-2" />
              {item.label}
            </Link>
          </Button>
        ))}
      </nav>
    </aside>
  );
};