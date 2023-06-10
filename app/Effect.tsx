'use client'
import React, { createRef, useEffect, useMemo, useRef, useState } from 'react'
import { Canvas, createPortal, extend, useFrame, useLoader, useThree, invalidate } from '@react-three/fiber';
import { Plane, shaderMaterial, useFBO } from '@react-three/drei';
import { ShaderMaterial, TextureLoader } from 'three';
import * as THREE from 'three'
import { Stats } from '@react-three/drei'

const prefix_vertex = `
    varying vec2 vUv;
    varying vec3 v_pos;

`

const common_vertex_main = `
    void main()	{
        vUv = uv;
        v_pos = position;
        gl_Position = vec4(position, 1.);
    }
`

const prefix_frag = `
    #ifdef GL_ES
    precision mediump float;
    #endif

    varying vec3 v_pos;
    varying vec2 vUv;
`

// # the 'pcg' hash method -> https://www.jcgt.org/published/0009/03/02/
const hash_functions=`
#define TWO_PI 6.283185
// https://www.shadertoy.com/view/XlGcRh

// https://www.pcg-random.org/
uint pcg(uint v)
{
	uint state = v * 747796405u + 2891336453u;
	uint word = ((state >> ((state >> 28u) + 4u)) ^ state) * 277803737u;
	return (word >> 22u) ^ word;
}

uvec2 pcg2d(uvec2 v)
{
    v = v * 1664525u + 1013904223u;

    v.x += v.y * 1664525u;
    v.y += v.x * 1664525u;

    v = v ^ (v>>16u);

    v.x += v.y * 1664525u;
    v.y += v.x * 1664525u;

    v = v ^ (v>>16u);

    return v;
}

// http://www.jcgt.org/published/0009/03/02/
uvec3 pcg3d(uvec3 v) {

    v = v * 1664525u + 1013904223u;

    v.x += v.y*v.z;
    v.y += v.z*v.x;
    v.z += v.x*v.y;

    v ^= v >> 16u;

    v.x += v.y*v.z;
    v.y += v.z*v.x;
    v.z += v.x*v.y;

    return v;
}


float hash11(float p) {
    return float(pcg(uint(p)))/4294967296.;
}

vec2 hash21(float p) {
    return vec2(pcg2d(uvec2(p, 0)))/4294967296.;
}

vec3 hash33(vec3 p3) {
    return vec3(pcg3d(uvec3(p3)))/4294967296.;
}
`

// # dual kawase blur downscale sample shader pass
const BlurDownSampleMaterial = shaderMaterial(
    {
      time: 0,
      buff_tex: null,
      resolution: [600, 600],
    },
    prefix_vertex + common_vertex_main,
    prefix_frag + `
        uniform float time;
        uniform vec2 resolution;
        uniform sampler2D buff_tex;
    
        void main() {
            vec2 uv = vUv*2.0;
            vec2 halfpixel = 0.5 / (resolution.xy / 2.0);
            float time_offset = (sin(time*4.) + 1.)/2.;
            float blur_offset = 6. * time_offset;
            //blur_offset = 0.;
        
            vec4 sum;
            sum = texture(buff_tex, uv) * 4.0;
            sum += texture(buff_tex, uv - halfpixel.xy * blur_offset);
            sum += texture(buff_tex, uv + halfpixel.xy * blur_offset);
            sum += texture(buff_tex, uv + vec2(halfpixel.x, -halfpixel.y) * blur_offset);
            sum += texture(buff_tex, uv - vec2(halfpixel.x, -halfpixel.y) * blur_offset);
        
            gl_FragColor = sum / 8.0;
        }
    `
);

// # dual kawase blur upscale sample shader pass
const BlurUpSampleMaterial = shaderMaterial(

    {
        time: 0,
        buff_tex: null,
        resolution: [600, 600],
    },
    prefix_vertex + common_vertex_main,
    prefix_frag + `
        uniform float time;
        uniform vec2 resolution;
        uniform sampler2D buff_tex;

        void main() {

            vec2 uv = vUv/2.0;
            vec2 halfpixel = 0.5 / (resolution.xy * 2.0);
            float time_offset = (sin(time*4.) + 1.)/2.;
            float blur_offset = 6. * time_offset;
            //blur_offset = 0.;
        
            vec4 sum;
            
            sum =  texture(buff_tex, uv +vec2(-halfpixel.x * 2.0, 0.0) * blur_offset);
            sum += texture(buff_tex, uv + vec2(-halfpixel.x, halfpixel.y) * blur_offset) * 2.0;
            sum += texture(buff_tex, uv + vec2(0.0, halfpixel.y * 2.0) * blur_offset);
            sum += texture(buff_tex, uv + vec2(halfpixel.x, halfpixel.y) * blur_offset) * 2.0;
            sum += texture(buff_tex, uv + vec2(halfpixel.x * 2.0, 0.0) * blur_offset);
            sum += texture(buff_tex, uv + vec2(halfpixel.x, -halfpixel.y) * blur_offset) * 2.0;
            sum += texture(buff_tex, uv + vec2(0.0, -halfpixel.y * 2.0) * blur_offset);
            sum += texture(buff_tex, uv + vec2(-halfpixel.x, -halfpixel.y) * blur_offset) * 2.0;
        
            gl_FragColor = sum / 12.0;
        }
    `
)

// # the wave shader,the core concept is use distance() function to compare the fragCoord & wave_center,
// # if the conditions are met,we use a pow() function to generate a wave shape in mathmatic,then map the function to the clamped distance(as x input)
const WaveMaterial =  shaderMaterial(
    {
        time: 0,
        buff_tex: null,
        resolution: [600, 600],
    },
    prefix_vertex + common_vertex_main,
    prefix_frag + `
    uniform float time;
    uniform vec2 resolution;
    uniform sampler2D buff_tex;
    #define iTime time
    #define iChannel0 buff_tex
    #define iResolution resolution

    float rand(vec2 co){
        return fract(sin(dot(co.xy ,vec2(12.9898,78.233))) * 43758.5453);
    }

    vec4 waveEffect(in vec2 uv){
        //Sawtooth function to pulse from centre.
        float offset = (iTime- floor(iTime))/iTime;
        float CurrentTime = (iTime)*(offset);    
        
        vec3 WaveParams = vec3(10.0, 0.8, 0.1);// distance,height,time
        
        float ratio = iResolution.y/iResolution.x;
           
        vec2 WaveCentre = vec2(0.5, 0.9);
        WaveCentre.y *= ratio; 
       
        vec2 texCoord = gl_FragCoord.xy / iResolution.xy;    
        texCoord.y *= ratio;    
        texCoord = uv;  
        
        //vec2 waveCoord = texCoord;
        //waveCoord.y *= ratio;
        float Dist = distance(vec2(texCoord.x,texCoord.y*2.), WaveCentre);

        vec4 Color = texture(iChannel0, texCoord);
        
        float outputCol;
        //Only distort the pixels within the parameter distance from the centre
        if ((Dist <= ((CurrentTime) + (WaveParams.z))) && (Dist >= ((CurrentTime) - (WaveParams.z)))) 
        {
            //The pixel offset distance based on the input parameters
            float Diff = (Dist - CurrentTime); 
            float ScaleDiff = (1.0 - pow(abs(Diff * WaveParams.x), WaveParams.y)); 
            float DiffTime = (Diff  * ScaleDiff);
            
            //The direction of the distortion
            vec2 DiffTexCoord = normalize(texCoord - WaveCentre);         
            
            //Perform the distortion and reduce the effect over time
            texCoord += ((DiffTexCoord * DiffTime) / (CurrentTime * Dist * 40.0));
            Color = texture(iChannel0, texCoord);
            
            //Blow out the color and reduce the effect over time
            Color += (Color * ScaleDiff) / (CurrentTime * Dist * 40.0);

            outputCol = ScaleDiff;
            
        } 

        //return vec4(vec3(outputCol),1.);
        return Color;
    }

    void main() {

        gl_FragColor = waveEffect(vUv);
    }
`);

// # compare to standard 'centered grid sampling' & 'staggered grid sampling'
// # this looks like a random sample in different grid 
const ParticleMaterial = shaderMaterial(
    {
        resolution:[600,600],
        time:0,
        buff_tex:null,
    },
    prefix_vertex + common_vertex_main,
    hash_functions + prefix_frag + `
    uniform float time;
    uniform vec2 resolution;
    uniform sampler2D buff_tex;
    #define iTime time
    #define iChannel0 buff_tex
    #define iResolution resolution

    const vec3 base_color = vec3(0.2, 0.3, 0.8);
    const float speed = 1.;
    const float burstRange = 150.;
    const float length = 0.0035;

    vec3 particleEffects(in vec2 fragCoord,in vec2 center){
        center = iResolution.xy*center;

        float c0 = 0., c1 = 0.;
    
        for(float i = 0.; i < 250.; ++i) {
            float t = speed*iTime + hash11(i);
    
            // # use time generate noise,the parameter is just the seed number
            vec2 v = hash21(i + 50.*floor(t));
            // # from 0 to 1 normalize the noised time
            t = fract(t);
            
            //v = vec2(sqrt(-2.*log(1.-v.x)), 6.283185*v.y);       
            // # polar the coordnates
            // # distance & emit around the center
            v = burstRange*v.x*vec2(cos(v.y*10.), sin(v.y*10.));
    
            vec2 p = center + t*v - fragCoord;
            // # the glow center
            // c0 += 0.1*(1.-t)/(1. + 0.13*dot(p,p));
    
            p = p.yx;
            v = v.yx;
            p = vec2(
                p.x/v.x,
                p.y - p.x/v.x*v.y
            );
            
            float a = abs(p.x) < length ? 50./abs(v.x) : 0.;
            float b0 = max(2. - abs(p.y), 0.);
            //float b1 = 0.2/(1.+0.0001*p.y*p.y);
            c0 += (1.-t)*b0*a;
            //c1 += (1.-t)*b1*a;
            
            // # accumulate particles,
            c0 += (t)*b0*a;
        }
    
        vec3 rgb = c0*base_color;
        //rgb += hash33(vec3(fragCoord,iTime*256.))/512.;
        rgb = pow(rgb, vec3(0.4545));  
        return rgb;      
    }

    void main() {
        vec2 center = vec2(0.5,0.95);
        vec3 particleColor = particleEffects(vUv*iResolution.xy,center);
        gl_FragColor = texture(buff_tex,vUv) + vec4(particleColor,1.);
    }
`
);

const ProceduralLightMaterial  = shaderMaterial(
    {
        resolution:[600,600],
        time:0,
        buff_tex:null,
    },
    prefix_vertex + common_vertex_main,
    prefix_frag + `
    
    // by Nikos Papadopoulos, 4rknova / 2013
    // Creative Commons Attribution-NonCommercial-ShareAlike 3.0 Unported License.

    #define ENABLE_LIGHTING
    #define ENABLE_SPECULAR

    #define OFFSET_X 1
    #define OFFSET_Y 1
    #define DEPTH	 1.

    uniform float time;
    uniform vec2 resolution;
    uniform sampler2D buff_tex;
    #define iTime time
    #define iChannel0 buff_tex
    #define iResolution resolution

    vec3 texsample(const int x, const int y, in vec2 fragCoord)
    {
        vec2 uv = fragCoord.xy ;
        uv = (uv + vec2(x, y)) / resolution.xy;
        return texture(iChannel0, uv).xyz;
    }
    
    float luminance(vec3 c)
    {
        return dot(c, vec3(.2126, .7152, .0722));
    }

    vec3 normal(in vec2 fragCoord)
    {
        float R = abs(luminance(texsample( OFFSET_X,0, fragCoord)));
        float L = abs(luminance(texsample(-OFFSET_X,0, fragCoord)));
        float D = abs(luminance(texsample(0, OFFSET_Y, fragCoord)));
        float U = abs(luminance(texsample(0,-OFFSET_Y, fragCoord)));
                    
        float X = (L-R) * .5;
        float Y = (U-D) * .5;

        return normalize(vec3(X, Y, 1. / DEPTH));
    }

    void main()
    {
        vec2 fragCoord = vUv * iResolution.xy;
        vec3 n = normal(fragCoord);

    #ifdef ENABLE_LIGHTING
        vec3 lp = vec3(vec2(iResolution.x*0.5,iResolution.y*( 0.1 + (cos(iTime) + 1.)/2.)*0.88) , 200.); //iMouse.xy
        vec3 sp = vec3(fragCoord.xy, 0.);
        
        vec3 c = texsample(0, 0, fragCoord) * dot(n, normalize(lp - sp));

    #ifdef ENABLE_SPECULAR
        float e = 16.;
        vec3 ep = vec3(fragCoord.xy, 200.);
        c += pow(clamp(dot(normalize(reflect(lp - sp, n)), normalize(sp - ep)), 0., 1.), e);
    #endif /* ENABLE_SPECULAR */
        
    #else
        vec3 c = n;
        
    #endif /* ENABLE_LIGHTING */
        
        gl_FragColor = mix(texture(buff_tex,vUv),vec4(c, 1),0.5);
    }
`)

extend({BlurDownSampleMaterial,BlurUpSampleMaterial,WaveMaterial,ParticleMaterial,ProceduralLightMaterial})

declare global {
    namespace JSX {
        interface IntrinsicElements {
            'blurDownSampleMaterial': React.DetailedHTMLProps<React.HTMLAttributes<ShaderMaterial>, ShaderMaterial>;
            'blurUpSampleMaterial': React.DetailedHTMLProps<React.HTMLAttributes<ShaderMaterial>, ShaderMaterial>;
            'waveMaterial': React.DetailedHTMLProps<React.HTMLAttributes<ShaderMaterial>, ShaderMaterial>;
            'particleMaterial':React.DetailedHTMLProps<React.HTMLAttributes<ShaderMaterial>, ShaderMaterial>;
            'proceduralLightMaterial':React.DetailedHTMLProps<React.HTMLAttributes<ShaderMaterial>, ShaderMaterial>;
        }
    }
}

const Interface = () => {

    const wp = useLoader(TextureLoader, './wallpaper.png')
    const ct = useLoader(TextureLoader, './contact.png')

    // # the renderer's context
    const {size,gl,scene,camera} = useThree()
    // # create Material ref for 'uniforms input'
    const kawaseBlurMaterialRefA = useRef<ShaderMaterial | null>(null)
    const kawaseBlurMaterialRefB = useRef<ShaderMaterial | null>(null)
    const kawaseBlurMaterialRefC = useRef<ShaderMaterial | null>(null)
    const kawaseBlurMaterialRefD = useRef<ShaderMaterial | null>(null)
    const waveMaterialRef = useRef<ShaderMaterial | null>(null)
    const particleMaterialRef = useRef<ShaderMaterial | null>(null)
    const proceduralLightMaterialRef = useRef<ShaderMaterial | null>(null)

    const FBOSettings ={
        format: THREE.RGBAFormat,
        //encoding:THREE.GammaEncoding,
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        type: THREE.FloatType,
    };
    // # create FBO for different render pass
    const kawaseBlurFBOA = useFBO(size.width,size.height,FBOSettings);
    const kawaseBlurFBOB = useFBO(size.width,size.height,FBOSettings);
    const kawaseBlurFBOC = useFBO(size.width,size.height,FBOSettings);
    const kawaseBlurFBOD = useFBO(size.width,size.height,FBOSettings);
    const waveFBO = useFBO(size.width,size.height,FBOSettings)
    const particleFBO = useFBO(size.width,size.height,FBOSettings)

    // # create scenes for different FBOS
    const [kawaseBlurSceneA,kawaseBlurSceneB,kawaseBlurSceneC,kawaseBlurSceneD,waveScene,particleScene] = useMemo(() => {
        const kawaseBlurSceneA = new THREE.Scene()
        const kawaseBlurSceneB = new THREE.Scene()
        const kawaseBlurSceneC = new THREE.Scene()
        const kawaseBlurSceneD = new THREE.Scene()
        const waveScene = new THREE.Scene()
        const particleScene = new THREE.Scene()
        
        return [kawaseBlurSceneA,kawaseBlurSceneB,kawaseBlurSceneC,kawaseBlurSceneD,waveScene,particleScene]
    }, []) 

    // #
    useEffect(()=>{
        if(waveMaterialRef.current){
            waveMaterialRef.current.uniforms.resolution.value = new THREE.Vector2(size.width,size.height);
        }

        if(particleMaterialRef.current){
            particleMaterialRef.current.uniforms.resolution.value = new THREE.Vector2(size.width,size.height);
        }

        if(proceduralLightMaterialRef.current){
            proceduralLightMaterialRef.current.uniforms.resolution.value = new THREE.Vector2(size.width,size.height);
        }

    },[])
    
    // #
    useFrame(({clock})=>{
        const time = clock.getElapsedTime()
        console.log('123')
        // DownSample - Pass 1
        if(kawaseBlurMaterialRefA.current){
            kawaseBlurMaterialRefA.current.uniforms.buff_tex.value = wp;
            kawaseBlurMaterialRefA.current.uniforms.time.value = time;

            // KawaseBlur Pass 1 Buffer
            gl.setRenderTarget(kawaseBlurFBOA);
            gl.render(kawaseBlurSceneA,camera)
            gl.setRenderTarget(null)
        }
            

        // DownSample - Pass 2
        if(kawaseBlurMaterialRefB.current){
            kawaseBlurMaterialRefB.current.uniforms.buff_tex.value = kawaseBlurFBOA.texture
            kawaseBlurMaterialRefB.current.uniforms.time.value = time;

            // KawaseBlur Pass 2 Buffer
            gl.setRenderTarget(kawaseBlurFBOB);
            gl.render(kawaseBlurSceneB,camera)
            gl.setRenderTarget(null)
        }

        // UpSample - Pass 3
        if(kawaseBlurMaterialRefC.current){
            kawaseBlurMaterialRefC.current.uniforms.buff_tex.value = kawaseBlurFBOB.texture
            kawaseBlurMaterialRefC.current.uniforms.time.value = time;

            // KawaseBlur Pass 3 Buffer
            gl.setRenderTarget(kawaseBlurFBOC);
            gl.render(kawaseBlurSceneC,camera)
            gl.setRenderTarget(null)
        }

        // UpSample - Pass 4        
        if(kawaseBlurMaterialRefD.current){
            kawaseBlurMaterialRefD.current.uniforms.buff_tex.value = kawaseBlurFBOC.texture
            kawaseBlurMaterialRefD.current.uniforms.time.value = time;

            // KawaseBlur Pass 4 Buffer
            gl.setRenderTarget(kawaseBlurFBOD);
            gl.render(kawaseBlurSceneD,camera)
            gl.setRenderTarget(null)
        }

        // WaveMaterial Pass
        if(waveMaterialRef.current){
            waveMaterialRef.current.uniforms.buff_tex.value = kawaseBlurFBOD.texture
            waveMaterialRef.current.uniforms.time.value = time;

            // Wave Pass Buffer
            gl.setRenderTarget(waveFBO);
            gl.render(waveScene,camera)
            gl.setRenderTarget(null)
        }

        if(particleMaterialRef.current){
            particleMaterialRef.current.uniforms.buff_tex.value = waveFBO.texture
            particleMaterialRef.current.uniforms.time.value = time;
            
            // Particle Pass Buffer
            gl.setRenderTarget(particleFBO);
            gl.render(particleScene,camera)
            gl.setRenderTarget(null)
        }

        // ProceduralLightMaterialRef Pass
        if(proceduralLightMaterialRef.current){
            proceduralLightMaterialRef.current.uniforms.buff_tex.value = particleFBO.texture; //particleFBO.texture
            proceduralLightMaterialRef.current.uniforms.time.value = time;
        }


        // to do : swap material
    })
    return (
    <>
        {createPortal(<>
          <Plane args={[2, 2]}>
             <blurDownSampleMaterial ref={kawaseBlurMaterialRefA}  />
          </Plane>
        </>, kawaseBlurSceneA)}

        {createPortal(<>
          <Plane args={[2, 2]}>
             <blurDownSampleMaterial ref={kawaseBlurMaterialRefB}  />
          </Plane>
        </>, kawaseBlurSceneB)}

        {createPortal(<>
          <Plane args={[2, 2]}>
             <blurUpSampleMaterial ref={kawaseBlurMaterialRefC}  />
          </Plane>
        </>, kawaseBlurSceneC)}

        {createPortal(<>
          <Plane args={[2, 2]}>
             <blurUpSampleMaterial ref={kawaseBlurMaterialRefD}  />
          </Plane>
        </>, kawaseBlurSceneD)}

        {createPortal(<>
          <Plane args={[2, 2]}>
             <waveMaterial ref={waveMaterialRef}  />
          </Plane>
        </>, waveScene)}

        {createPortal(<>
          <Plane args={[2, 2]}>
             <particleMaterial ref={particleMaterialRef}  />
          </Plane>
        </>, particleScene)}

        <Plane args={[2, 2]}>
            <proceduralLightMaterial ref={proceduralLightMaterialRef}  />
        </Plane>
        

    </>
    )

}

export const Effect = (props:any) =>{


  return(
  <Canvas className={props.className} style={{...props.style}}>
    <ambientLight />
    <Interface />
    <Stats />
  </Canvas>
  )
}