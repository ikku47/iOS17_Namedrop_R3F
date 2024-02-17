/* eslint-disable react/no-unescaped-entities */
'use client'
import Image from 'next/image'
import { Effect } from './Effect'
import useState from 'react';

export default function Home() {

  return (
    <main className="flex w-screen h-screen overflow-hidden flex-col items-center justify-between p-4">
      <div >
        <Effect className="origin-top scale-75" style={{
            width:'297px',
            height:'634px',
            borderRadius: '43px',
            visibility: 'visible',
            position: 'absolute',
            top: '50%',
            left: '50%',
            transform: 'translate(-50%, -50%)',
            transformOrigin: 'center',
            cursor:'pointer'
        }}/>
        <img
          className='phone-img'
          src="/ip14_pro.png"
          width={876/2}
          height={1774/2}
          alt="Picture of the author"
        />
      </div>
    </main>
  )
}
