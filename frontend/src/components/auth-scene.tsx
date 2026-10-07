'use client';
import type { ReactNode } from 'react';
export function AuthScene({ heading, description, features, children }: {
    heading: string;
    description: string;
    features: string[];
    children: ReactNode;
}) {
    return <main className="auth-scene"><section className="auth-story"><div className="auth-orbit" aria-hidden="true"><span className="orbit-ring"/><span className="orbit-ring ring-two"/><div className="orbit-card"><span>PPTX</span><div className="slide-shape"/><div className="slide-lines"><i /><i /><i /></div></div><span className="orbit-dot"/></div><h2>{heading}</h2><p>{description}</p><div className="auth-features">{features.map(value => <span key={value}><b aria-hidden="true">✦</b>{value}</span>)}</div></section><section className="auth-panel">{children}</section></main>;
}
