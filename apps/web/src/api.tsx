import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import type { User } from '@odas/contracts';
let csrfToken='';
export class ApiError extends Error { constructor(public status:number,message:string,public code?:string){super(message);} }
export async function api<T=any>(path:string,options:RequestInit={}):Promise<T>{
 const method=(options.method||'GET').toUpperCase();
 if(!['GET','HEAD','OPTIONS'].includes(method)&&!csrfToken){const response=await fetch('/api/auth/session',{credentials:'include'});const data=await response.json();csrfToken=data.csrfToken||'';}
 const response=await fetch(path.startsWith('/api/')?path:`/api${path.startsWith('/')?path:'/'+path}`,{...options,credentials:'include',headers:{...(options.body?{'Content-Type':'application/json'}:{}),...(!['GET','HEAD','OPTIONS'].includes(method)?{'X-CSRF-Token':csrfToken}:{}),...options.headers}});
 const data=response.status===204?null:await response.json().catch(()=>({error:'The server returned an unreadable response.'}));
 if(data?.csrfToken)csrfToken=data.csrfToken;
 if(!response.ok)throw new ApiError(response.status,data?.error||'Something went wrong. Please try again.',data?.code);
 return data as T;
}
const SessionContext=createContext<{user:User|null;loading:boolean;refresh:()=>Promise<void>}>({user:null,loading:true,refresh:async()=>{}});
export function SessionProvider({children}:{children:ReactNode}){const[user,setUser]=useState<User|null>(null);const[loading,setLoading]=useState(true);const refresh=useCallback(async()=>{try{const data=await api<{user:User|null;csrfToken:string}>('/auth/session');setUser(data.user);}finally{setLoading(false);}},[]);useEffect(()=>{void refresh().catch(()=>setLoading(false));},[refresh]);return <SessionContext.Provider value={{user,loading,refresh}}>{children}</SessionContext.Provider>;}
export const useSession=()=>useContext(SessionContext);
